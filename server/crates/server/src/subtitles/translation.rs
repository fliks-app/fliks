//! Translation engines over HTTP (`docs/spec/translation.md` rules 1-4, 30-34): the transport and
//! the engine bodies; batching, retry and prompts are `fliks_domain::translation`.
use super::Shared;
use crate::http::AppError;
use crate::sync::MutexExt;
use axum::http::StatusCode;
use fliks_domain::translation::{
    Attempt, BATCH_SIZE, BatchError, Driver, Limits, MAX_OUTPUT_TOKENS, Pacer, Post,
    REGISTER_PROBE_MAX_OUTPUT_TOKENS, Reply, Request, TranslationError, build_payload,
    build_system_instruction, is_unknown_language, parse_numbered, post_with_retry,
    translate_with_batching, with_register,
};
use reqwest::{Client, RequestBuilder, Response, Url};
use serde_json::{Value, json};
use std::{sync::Mutex, time::Duration};

pub const DEFAULT_MODEL: &str = "gemini-3.5-flash-lite";
pub const ENGINES: [&str; 3] = ["gemini", "openai", "libretranslate"];
const REQUEST_TIMEOUT: Duration =
    Duration::from_millis(fliks_domain::translation::REQUEST_TIMEOUT_MS);
const LISTING_TIMEOUT: Duration = Duration::from_secs(15);
const GEMINI_OUTPUT_CEILING: u64 = 65_536;
const GEMINI_BATCH_CEILING: u64 = 500;
const CHUNK: usize = 25;

/// Process-wide pacing of `tokensPerMinute` windows.
#[derive(Default)]
pub struct Pacing(pub Mutex<Pacer>);

#[derive(Debug, Clone, Default)]
pub struct Cfg {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub url: String,
    pub max_tokens_per_request: u64,
    pub tokens_per_minute: u64,
}

fn text(s: &Value, k: &str) -> String {
    s.get(k)
        .and_then(Value::as_str)
        .map(|v| v.trim().to_owned())
        .unwrap_or_default()
}

fn count(s: &Value, k: &str) -> u64 {
    let n = match s.get(k) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(t)) => t.trim().parse().ok(),
        _ => None,
    };
    n.filter(|n| n.is_finite() && *n > 0.0)
        .map_or(0, |n| n.floor() as u64)
}

pub fn config(engine: &str, s: &Value) -> Cfg {
    Cfg {
        api_key: text(s, "apiKey"),
        model: match (engine, text(s, "model")) {
            ("gemini", m) if m.is_empty() => DEFAULT_MODEL.into(),
            (_, m) => m,
        },
        base_url: text(s, "baseUrl"),
        url: text(s, "url"),
        max_tokens_per_request: count(s, "maxTokensPerRequest"),
        tokens_per_minute: count(s, "tokensPerMinute"),
    }
}

/// `http`/`https` with a host.
fn http_url(u: &str) -> bool {
    Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
}

pub fn validate_config(engine: &str, s: &Value) -> Result<(), AppError> {
    let c = config(engine, s);
    match engine {
        "gemini" if c.api_key.is_empty() => Err(AppError::bad_request("Gemini API key is not set")),
        "openai" if c.base_url.is_empty() || c.model.is_empty() => Err(AppError::bad_request(
            "An OpenAI-compatible base URL and model are required",
        )),
        "openai" if !http_url(&c.base_url) => Err(AppError::bad_request(
            "The OpenAI-compatible base URL must be an http(s) URL",
        )),
        "libretranslate" if c.url.is_empty() => {
            Err(AppError::bad_request("The LibreTranslate URL is not set"))
        }
        "libretranslate" if !http_url(&c.url) => Err(AppError::bad_request(
            "The LibreTranslate URL must be an http(s) URL",
        )),
        _ => Ok(()),
    }
}

/// A a stored value that is not an http(s) URL is refused on write.
pub fn validate_url_fields(engine: &str, s: &Value) -> Result<(), AppError> {
    let c = config(engine, s);
    match engine {
        "openai" if !c.base_url.is_empty() && !http_url(&c.base_url) => Err(AppError::bad_request(
            "The OpenAI-compatible base URL must be an http(s) URL",
        )),
        "libretranslate" if !c.url.is_empty() && !http_url(&c.url) => Err(AppError::bad_request(
            "The LibreTranslate URL must be an http(s) URL",
        )),
        _ => Ok(()),
    }
}

pub fn resolve_model(engine: &str, s: &Value) -> Option<String> {
    let c = config(engine, s);
    matches!(engine, "gemini" | "openai").then_some(c.model)
}

fn trim_slashes(u: &str) -> &str {
    u.trim_end_matches('/')
}

/// One POST of an engine, retried by `post_with_retry`; secrets never reach an error text.
struct HttpPost<'a> {
    client: &'a Client,
    url: String,
    headers: Vec<(&'static str, String)>,
    body: String,
    secret: String,
}

impl HttpPost<'_> {
    fn request(&self) -> RequestBuilder {
        let mut r = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json");
        for (k, v) in &self.headers {
            r = r.header(*k, v);
        }
        r.body(self.body.clone()).timeout(REQUEST_TIMEOUT)
    }

    fn redact(&self, s: String) -> String {
        if self.secret.is_empty() {
            s
        } else {
            s.replace(&self.secret, "***")
        }
    }
}

impl Post for HttpPost<'_> {
    type Resp = Response;

    async fn send(&mut self) -> Attempt<Response> {
        match self.request().send().await {
            Err(e) => Attempt::Network(self.redact(format!("Error: {}", e.without_url()))),
            Ok(r) if r.status().is_success() => Attempt::Ok(r),
            Ok(r) => {
                let status = r.status().as_u16();
                let retry_after = r
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let body = r.text().await.unwrap_or_default();
                Attempt::Failed(Reply {
                    status,
                    retry_after,
                    body: self.redact(body),
                })
            }
        }
    }

    async fn sleep(&mut self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    fn warn(&mut self, m: String) {
        tracing::warn!("{m}");
    }
}

/// A 2xx body that is not JSON is an error, as `res.json()` throws.
async fn json_of(r: Response) -> Result<Value, TranslationError> {
    r.json()
        .await
        .map_err(|e| TranslationError::Other(format!("Error: {}", e.without_url())))
}

/// Gemini joins the `text` of every part.
fn join_parts(parts: &Value) -> String {
    parts
        .as_array()
        .map(|a| a.iter().map(|p| p["text"].as_str().unwrap_or("")).collect())
        .unwrap_or_default()
}

fn thinking(model: &str) -> Value {
    if model.starts_with("gemini-3") {
        json!({"thinkingConfig": {"thinkingLevel": "low"}})
    } else if model.starts_with("gemma-4") {
        json!({"thinkingConfig": {"thinkingLevel": "minimal"}})
    } else {
        json!({})
    }
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        b.extend(e.clone());
    }
    base
}

/// A model listing: one GET, no retry (rule 13).
async fn listing(
    client: &Client,
    url: &str,
    headers: &[(&'static str, String)],
    label: &str,
) -> Result<Value, String> {
    let mut r = client.get(url).timeout(LISTING_TIMEOUT);
    for (k, v) in headers {
        r = r.header(*k, v);
    }
    let res = r
        .send()
        .await
        .map_err(|e| format!("Error: {}", e.without_url()))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body: String = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        return Err(format!("{label} model list failed ({status}): {body}"));
    }
    json_of(res).await.map_err(|e| e.to_string())
}

pub enum ListError {
    Bad(AppError),
    Gateway(String),
}

pub async fn list_models(sh: &Shared, engine: &str, s: &Value) -> Result<Vec<String>, ListError> {
    let c = config(engine, s);
    let fail = |m: &str, secret: &str| {
        ListError::Gateway(if secret.is_empty() {
            m.to_owned()
        } else {
            m.replace(secret, "***")
        })
    };
    match engine {
        "gemini" => {
            if c.api_key.is_empty() {
                return Err(ListError::Bad(AppError::bad_request(
                    "Gemini API key is not set",
                )));
            }
            let url = format!("{}/models?pageSize=1000", sh.bases.gemini);
            let data = listing(
                &sh.plain,
                &url,
                &[("x-goog-api-key", c.api_key.clone())],
                "Gemini",
            )
            .await
            .map_err(|e| fail(&e, &c.api_key))?;
            let mut names: Vec<String> = data["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| {
                    m["supportedGenerationMethods"]
                        .as_array()
                        .is_some_and(|g| g.iter().any(|x| x == "generateContent"))
                })
                .map(|m| {
                    m["name"]
                        .as_str()
                        .unwrap_or("")
                        .trim_start_matches("models/")
                        .to_owned()
                })
                .collect();
            names.sort();
            Ok(names)
        }
        "openai" => {
            if c.base_url.is_empty() {
                return Err(ListError::Bad(AppError::bad_request(
                    "An OpenAI-compatible base URL is required",
                )));
            }
            if !http_url(&c.base_url) {
                return Err(ListError::Bad(AppError::bad_request(
                    "The OpenAI-compatible base URL must be an http(s) URL",
                )));
            }
            let headers: Vec<_> = (!c.api_key.is_empty())
                .then(|| ("Authorization", format!("Bearer {}", c.api_key)))
                .into_iter()
                .collect();
            let data = listing(
                &sh.plain,
                &format!("{}/models", trim_slashes(&c.base_url)),
                &headers,
                "OpenAI-compatible",
            )
            .await
            .map_err(|e| fail(&e, &c.api_key))?;
            let mut ids: Vec<String> = data["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| m["id"].as_str().unwrap_or("").to_owned())
                .filter(|i| !i.is_empty())
                .collect();
            ids.sort();
            Ok(ids)
        }
        _ => Ok(vec![]),
    }
}

/// The engine's batches over `translate_with_batching`.
struct Engine<'a> {
    sh: &'a Shared,
    cfg: &'a Cfg,
    kind: &'a str,
    system: String,
    url: String,
    on_progress: &'a mut (dyn FnMut(usize, usize) + Send + Sync),
}

impl Engine<'_> {
    fn post(&self, body: Value) -> HttpPost<'_> {
        let mut headers = vec![];
        let label_key = &self.cfg.api_key;
        if self.kind == "gemini" {
            headers.push(("x-goog-api-key", label_key.clone()));
        } else if !label_key.is_empty() {
            headers.push(("Authorization", format!("Bearer {label_key}")));
        }
        HttpPost {
            client: &self.sh.plain,
            url: self.url.clone(),
            headers,
            body: body.to_string(),
            secret: label_key.clone(),
        }
    }

    fn label(&self) -> &'static str {
        if self.kind == "gemini" {
            "Gemini"
        } else {
            "OpenAI-compatible"
        }
    }
}

impl Driver for Engine<'_> {
    async fn call(
        &mut self,
        texts: &[String],
        max: u64,
    ) -> Result<Option<Vec<String>>, BatchError> {
        let user = build_payload(texts);
        let body = if self.kind == "gemini" {
            json!({
                "systemInstruction": {"parts": [{"text": self.system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": merge(json!({"temperature": 0.3, "maxOutputTokens": max}), thinking(&self.cfg.model)),
            })
        } else {
            json!({
                "model": self.cfg.model, "temperature": 0.3, "max_tokens": max,
                "messages": [{"role": "system", "content": self.system}, {"role": "user", "content": user}],
            })
        };
        let mut p = self.post(body);
        let res = post_with_retry(&mut p, self.label())
            .await
            .map_err(|e| match e {
                TranslationError::TooLarge(m) => BatchError::TooLarge(m),
                other => BatchError::Other(other),
            })?;
        let data = json_of(res).await.map_err(BatchError::Other)?;
        if self.kind == "gemini" {
            let cand = &data["candidates"][0];
            if cand["finishReason"] == "MAX_TOKENS" {
                return Err(BatchError::TooLarge(format!(
                    "Gemini truncated {} cues at the output budget (usage={})",
                    texts.len(),
                    data["usageMetadata"]
                )));
            }
            let parts = &cand["content"]["parts"];
            if !parts.is_array() {
                tracing::warn!("Gemini returned no content for {} cues", texts.len());
                return Ok(None);
            }
            return Ok(parse_numbered(&join_parts(parts), texts.len()));
        }
        let choice = &data["choices"][0];
        if choice["finish_reason"] == "length" {
            return Err(BatchError::TooLarge(format!(
                "OpenAI-compatible endpoint truncated {} cues at its context limit (usage={}); set maxTokensPerRequest to what it actually accepts",
                texts.len(),
                data["usage"]
            )));
        }
        Ok(choice["message"]["content"]
            .as_str()
            .and_then(|t| parse_numbered(t, texts.len())))
    }

    async fn sleep(&mut self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    fn now_ms(&mut self) -> u64 {
        super::providers::limiter::now_ms().max(0) as u64
    }

    fn reserve(&mut self, key: &str, allowance: u64, tokens: u64, now: u64) -> Option<u64> {
        self.sh
            .pacing
            .0
            .lock_clean()
            .try_reserve(key, allowance, tokens, now)
    }

    fn progress(&mut self, done: usize, total: usize) {
        (self.on_progress)(done, total);
    }

    fn warn(&mut self, m: String) {
        tracing::warn!("{m}");
    }
}

/// Translates `texts`; each engine's request shape is spec rules 30-34.
pub async fn translate(
    sh: &Shared,
    engine: &str,
    texts: &[String],
    req: Request,
    s: &Value,
    on_progress: &mut (dyn FnMut(usize, usize) + Send + Sync),
) -> Result<Vec<String>, TranslationError> {
    let cfg = config(engine, s);
    if engine == "libretranslate" {
        return libre(sh, &cfg, texts, &req, on_progress).await;
    }
    let gemini = engine != "openai";
    let url = if gemini {
        format!(
            "{}/models/{}:generateContent",
            sh.bases.gemini,
            super::providers::enc(&cfg.model)
        )
    } else {
        format!("{}/chat/completions", trim_slashes(&cfg.base_url))
    };
    let kind = if gemini { "gemini" } else { "openai" };
    // The register probe, then the batches with the register in the system prompt.
    let mut noop = |_: usize, _: usize| {};
    let probe = Engine {
        sh,
        cfg: &cfg,
        kind,
        system: String::new(),
        url: url.clone(),
        on_progress: &mut noop,
    };
    let label = probe.label();
    let ask = |system: String, user: String| {
        let body = if gemini {
            json!({
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": merge(json!({"temperature": 0, "maxOutputTokens": REGISTER_PROBE_MAX_OUTPUT_TOKENS}), thinking(&cfg.model)),
            })
        } else {
            json!({
                "model": cfg.model, "temperature": 0, "max_tokens": REGISTER_PROBE_MAX_OUTPUT_TOKENS,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            })
        };
        let mut p = probe.post(body);
        async move {
            let res = post_with_retry(&mut p, label).await?;
            let data = json_of(res).await?;
            Ok(if gemini {
                join_parts(&data["candidates"][0]["content"]["parts"])
            } else {
                match &data["choices"][0]["message"]["content"] {
                    Value::Null => String::new(),
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                }
            })
        }
    };
    let req = with_register(req, texts, ask, |m| tracing::warn!("{m}")).await;
    let system = build_system_instruction(&req);
    let limits = Limits {
        max_tokens_per_request: cfg.max_tokens_per_request,
        tokens_per_minute: cfg.tokens_per_minute,
        key: if gemini {
            format!("gemini:{}", cfg.model)
        } else {
            format!("openai:{url}:{}", cfg.model)
        },
        output_ceiling: if gemini {
            GEMINI_OUTPUT_CEILING
        } else {
            MAX_OUTPUT_TOKENS
        },
        batch_ceiling: if gemini {
            GEMINI_BATCH_CEILING
        } else {
            BATCH_SIZE
        },
    };
    let mut d = Engine {
        sh,
        cfg: &cfg,
        kind,
        system: system.clone(),
        url,
        on_progress,
    };
    translate_with_batching(&mut d, texts, limits, &system).await
}

async fn libre(
    sh: &Shared,
    cfg: &Cfg,
    texts: &[String],
    req: &Request,
    on_progress: &mut (dyn FnMut(usize, usize) + Send + Sync),
) -> Result<Vec<String>, TranslationError> {
    let url = format!("{}/translate", trim_slashes(&cfg.url));
    let source = if is_unknown_language(&req.source_language) {
        "auto"
    } else {
        &req.source_language
    };
    let (mut out, mut translated) = (Vec::<String>::new(), 0);
    for (n, chunk) in texts.chunks(CHUNK).enumerate() {
        let mut body =
            json!({"q": chunk, "source": source, "target": req.target_language, "format": "text"});
        if !cfg.api_key.is_empty() {
            body["api_key"] = json!(cfg.api_key);
        }
        let mut p = HttpPost {
            client: &sh.plain,
            url: url.clone(),
            headers: vec![],
            body: body.to_string(),
            secret: cfg.api_key.clone(),
        };
        let res = post_with_retry(&mut p, "LibreTranslate").await?;
        let data = json_of(res).await?;
        let arr: Option<Vec<String>> = match &data["translatedText"] {
            Value::Array(a) => Some(
                a.iter()
                    .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned))
                    .collect(),
            ),
            Value::String(t) if chunk.len() == 1 => Some(vec![t.clone()]),
            _ => None,
        };
        match arr.filter(|a| a.len() == chunk.len()) {
            Some(a) => {
                out.extend(a);
                translated += 1;
            }
            None => {
                tracing::warn!(
                    "Unexpected LibreTranslate response shape for a {}-cue chunk; keeping source text",
                    chunk.len()
                );
                out.extend(chunk.iter().cloned());
            }
        }
        on_progress(((n + 1) * CHUNK).min(texts.len()), texts.len());
    }
    if !texts.is_empty() && translated == 0 {
        return Err(TranslationError::Other(
            "LibreTranslate returned no usable translation for any chunk".into(),
        ));
    }
    Ok(out)
}

pub fn gateway(msg: String) -> AppError {
    AppError::with_message(StatusCode::BAD_GATEWAY, msg)
}
