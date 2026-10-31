//! Translation engines' pure core (`translation-core.ts`): prompts, numbering, register, batching, retry.
//! The HTTP transport and the clock are injected so the state machines replay against scripted engines.
use crate::js::{rx, trim, u16len};
use crate::language::app_language_by_iso;
use crate::media::kind::MediaKind;
use std::{collections::HashMap, future::Future};

pub const MAX_OUTPUT_TOKENS: u64 = 8192;
pub const BATCH_SIZE: u64 = 150;
pub const MIN_TOKENS_PER_REQUEST: u64 = 2048;
pub const REQUEST_TIMEOUT_MS: u64 = 240_000;
pub const REGISTER_PROBE_MAX_OUTPUT_TOKENS: u64 = 500;
const CHARS_PER_TOKEN: usize = 4;
const MARKER_TOKENS: u64 = 4;
/// Terminal upstream bodies are cut here; the quota and size tests read the whole body.
pub const UPSTREAM_TEXT: usize = 300;
const MAX_ATTEMPTS: u32 = 4;
const QUOTA_RETRY_MS: u64 = 20_000;
const MAX_CONSECUTIVE_MISMATCHES: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Daily,
    PerMinute,
    Unknown,
}

impl Scope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Scope::Daily => "daily",
            Scope::PerMinute => "per-minute",
            Scope::Unknown => "unknown",
        }
    }
}

/// The three typed failures of a run; `Other` carries a plain message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslationError {
    RateLimit { message: String, scope: Scope },
    TooLarge(String),
    Other(String),
}

impl std::fmt::Display for TranslationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RateLimit { message, .. } | Self::TooLarge(message) | Self::Other(message) => {
                f.write_str(message)
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Context {
    pub title: Option<String>,
    pub year: Option<i64>,
    pub media_type: Option<MediaKind>,
    pub genres: Vec<String>,
    pub overview: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub source_language: String,
    pub target_language: String,
    pub context: Context,
    pub register: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_tokens_per_request: u64,
    pub tokens_per_minute: u64,
    pub key: String,
    pub output_ceiling: u64,
    pub batch_ceiling: u64,
}

pub fn estimate_tokens(text: &str) -> u64 {
    u16len(text).div_ceil(CHARS_PER_TOKEN) as u64
}

pub fn is_unknown_language(iso: &str) -> bool {
    iso.is_empty() || iso == "und" || iso == "xx"
}

fn language_name(iso: &str) -> String {
    if is_unknown_language(iso) {
        return "the original language".into();
    }
    app_language_by_iso(iso).map_or_else(|| iso.to_owned(), |l| l.name.to_owned())
}

struct Forms(&'static str, &'static str);

fn second_person(target: &str) -> Option<Forms> {
    Some(match target {
        "fr" => Forms("tu", "vous"),
        "de" => Forms("du", "Sie"),
        "es" => Forms("tú", "usted"),
        "it" => Forms("tu", "Lei"),
        "pt" => Forms("tu", "você"),
        "nl" => Forms("je", "u"),
        "ru" => Forms("ты", "вы"),
        _ => return None,
    })
}

pub fn has_register_choice(target: &str) -> bool {
    second_person(target).is_some()
}

pub fn build_register_probe(req: &Request, sample: &[String]) -> Option<(String, String)> {
    let f = second_person(&req.target_language)?;
    let kind = match req.context.media_type {
        Some(MediaKind::Series) => "series",
        Some(MediaKind::Movie) | None => "film",
    };
    Some((
        format!(
            "These are subtitles from a {kind} being translated into {}. Judging from how the characters speak to each other, answer with exactly one word, \"{}\" or \"{}\", naming the second-person form they would use. Answer with that word alone.",
            language_name(&req.target_language),
            f.0,
            f.1
        ),
        sample.join("\n"),
    ))
}

/// The register named by a probe answer; `None` when it names neither or both forms.
pub fn parse_register(answer: &str, target: &str) -> Option<String> {
    let f = second_person(target)?;
    static THINK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(&format!(
            r"(?is)^[{}]*<think>.*?(?:</think>|\z)",
            crate::js::WS_CLASS
        ))
        .expect("static")
    });
    let body = THINK.replace(answer, "");
    let lower = body.to_lowercase();
    let words: Vec<&str> = rx!(r"\p{L}+")
        .find_iter(&lower)
        .map(|m| m.as_str())
        .collect();
    let informal = words.contains(&f.0.to_lowercase().as_str());
    let formal = words.contains(&f.1.to_lowercase().as_str());
    if informal == formal {
        return None;
    }
    Some(if informal { f.0 } else { f.1 }.to_owned())
}

/// Unbroken runs of dialogue from a few points in the file.
pub fn register_sample(texts: &[String], windows: usize, per_window: usize) -> Vec<String> {
    if texts.len() <= windows * per_window {
        return texts.to_vec();
    }
    let mut out = vec![];
    for w in 0..windows {
        let start = (w + 1) * texts.len() / (windows + 1);
        out.extend(
            texts[start.min(texts.len())..(start + per_window).min(texts.len())]
                .iter()
                .cloned(),
        );
        out.push(String::new());
    }
    out
}

fn register_instruction(req: &Request) -> String {
    let (Some(f), Some(reg)) = (second_person(&req.target_language), &req.register) else {
        return String::new();
    };
    let other = if reg == f.0 { f.1 } else { f.0 };
    format!(
        " These speakers use \"{reg}\" with each other. Use it wherever a line gives no clear indication of its own, set phrases included; where a line clearly shows a different relationship, use \"{other}\" instead."
    )
}

/// First `n` UTF-16 units (JS `slice(0, n)`); a split pair becomes U+FFFD.
fn slice16(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

pub fn build_system_instruction(req: &Request) -> String {
    let c = &req.context;
    let kind = match c.media_type {
        Some(MediaKind::Series) => "series",
        Some(MediaKind::Movie) | None => "movie",
    };
    let mut bits = vec![];
    if let Some(t) = c.title.as_deref().filter(|t| !t.is_empty()) {
        let year = c
            .year
            .filter(|y| *y != 0)
            .map_or(String::new(), |y| format!(" ({y})"));
        bits.push(format!("titled \"{t}\"{year}"));
    }
    if !c.genres.is_empty() {
        bits.push(format!("genres: {}", c.genres.join(", ")));
    }
    let context_line = if bits.is_empty() {
        String::new()
    } else {
        format!(" This is a {kind} {}.", bits.join(", "))
    };
    let synopsis = match c.overview.as_deref().map(trim).filter(|o| !o.is_empty()) {
        Some(o) => format!(" Synopsis: {}", slice16(o, 300)),
        None => String::new(),
    };
    [
        format!(
            "You are a professional subtitle translator. Translate the subtitle segments from {} to {}.{context_line}{synopsis}{}",
            language_name(&req.source_language), language_name(&req.target_language), register_instruction(req)
        ),
        "Each input segment is introduced by a line \"#N#\" where N is its number.".into(),
        "Return every translation introduced by the same \"#N#\" line, in the same order, using the exact same set of numbers.".into(),
        "A segment may run across several lines: translate it as one whole sentence, never line by line.".into(),
        "The translation must be no longer in characters than the source segment, so it can be read in the same time. Shorten the wording if needed.".into(),
        "Keep proper nouns and names. Keep it concise and natural for on-screen subtitles.".into(),
        "Output only the numbered translations — no notes, no explanations, no code fences.".into(),
    ]
    .join("\n")
}

pub fn build_payload(texts: &[String]) -> String {
    texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("#{}#\n{t}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The numbered response as an ordered list; `None` when a segment is missing.
pub fn parse_numbered(response: &str, count: usize) -> Option<Vec<String>> {
    let mut map: HashMap<usize, Vec<String>> = HashMap::new();
    let mut current: Option<usize> = None;
    for line in response.replace("\r\n", "\n").split('\n') {
        if rx!(r"^\s*```").is_match(line) {
            continue;
        }
        if let Some(m) = rx!(r"^\s*#([0-9]+)#[ \t]*([^\n\r\x{2028}\x{2029}]*)$").captures(line) {
            let n: usize = m[1].parse().unwrap_or(usize::MAX);
            current = Some(n);
            map.insert(
                n,
                if m[2].is_empty() {
                    vec![]
                } else {
                    vec![m[2].to_owned()]
                },
            );
            continue;
        }
        if let Some(seg) = current.and_then(|c| map.get_mut(&c)) {
            seg.push(line.to_owned());
        }
    }
    (1..=count)
        .map(|i| map.get(&i).map(|s| trim(&s.join("\n")).to_owned()))
        .collect()
}

// ---- transport and retry -------------------------------------------------------------------

/// A non-2xx answer.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

pub enum Attempt<R> {
    Ok(R),
    Failed(Reply),
    /// DNS, TLS, reset or timeout.
    Network(String),
}

pub trait Post: Send {
    type Resp: Send;
    fn send(&mut self) -> impl Future<Output = Attempt<Self::Resp>> + Send;
    fn sleep(&mut self, ms: u64) -> impl Future<Output = ()> + Send;
    fn warn(&mut self, _message: String) {}
}

fn backoff_delay(attempt: u32) -> u64 {
    (1000u64 << (attempt - 1)).min(30_000)
}

/// `Number(x)` of a header, finite and positive only.
fn header_seconds(h: Option<&str>) -> Option<f64> {
    let t = trim(h?);
    let n: f64 = if t.is_empty() { 0.0 } else { t.parse().ok()? };
    (n.is_finite() && n > 0.0).then_some(n)
}

/// A Gemini `RetryInfo` delay (`"38s"`) in ms.
pub fn parse_retry_delay_ms(body: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    for d in v.get("error")?.get("details")?.as_array()? {
        if let Some(s) = d.get("retryDelay").and_then(|r| r.as_str())
            && let Some(m) = rx!(r"^([0-9.]+)s$").captures(s)
        {
            return Some(crate::js::round(parse_float(&m[1]) * 1000.0) as u64);
        }
    }
    None
}

/// `parseFloat` of `[0-9.]+`: the longest valid numeric prefix.
fn parse_float(s: &str) -> f64 {
    let mut end = 0;
    let mut dot = false;
    for (i, c) in s.char_indices() {
        match c {
            '0'..='9' => end = i + 1,
            '.' if !dot => {
                dot = true;
                end = i + 1;
            }
            _ => break,
        }
    }
    s[..end].parse().unwrap_or(0.0)
}

pub async fn post_with_retry<P: Post>(p: &mut P, label: &str) -> Result<P::Resp, TranslationError> {
    for attempt in 1..=MAX_ATTEMPTS {
        let reply = match p.send().await {
            Attempt::Ok(r) => return Ok(r),
            Attempt::Network(e) => {
                if attempt >= MAX_ATTEMPTS {
                    return Err(TranslationError::Other(format!(
                        "{label} request failed after {MAX_ATTEMPTS} attempts: {e}"
                    )));
                }
                p.sleep(backoff_delay(attempt)).await;
                continue;
            }
            Attempt::Failed(r) => r,
        };
        let err = &reply.body;
        let quota =
            reply.status == 429 || rx!(i r"rate.?limit|per minute|\bTPM\b|quota").is_match(err);
        let daily = quota && rx!(i r"PerDay|per day|requests per day").is_match(err);
        if !quota
            && (reply.status == 413
                || rx!(i r"context[_ ]length|too large|max_tokens").is_match(err))
        {
            return Err(TranslationError::TooLarge(format!(
                "{label} rejected the request as too large: {}",
                slice16(err, UPSTREAM_TEXT)
            )));
        }
        let retryable = matches!(reply.status, 429 | 500 | 502 | 503 | 504);
        if !daily && (quota || retryable) && attempt < MAX_ATTEMPTS {
            let suggested = parse_retry_delay_ms(err).or_else(|| {
                header_seconds(reply.retry_after.as_deref()).map(|s| (s * 1000.0) as u64)
            });
            p.warn(format!(
                "{label} answered {} on attempt {attempt}/{MAX_ATTEMPTS}, waiting: {}",
                reply.status,
                slice16(err, 200)
            ));
            let wait = suggested
                .unwrap_or(0)
                .max(backoff_delay(attempt))
                .max(if quota { QUOTA_RETRY_MS } else { 0 });
            p.sleep(wait.min(60_000)).await;
            continue;
        }
        if quota {
            let retry = parse_retry_delay_ms(err).filter(|r| *r != 0);
            let scope = if daily {
                Scope::Daily
            } else if rx!(i r"PerMinute").is_match(err) {
                Scope::PerMinute
            } else {
                Scope::Unknown
            };
            let delay = retry.map_or(String::new(), |r| {
                format!(", retryDelay={}s", crate::js::round(r as f64 / 1000.0))
            });
            return Err(TranslationError::RateLimit {
                message: format!(
                    "{label} quota/rate limit exceeded (scope={}{delay}): {}",
                    scope.as_str(),
                    slice16(err, UPSTREAM_TEXT)
                ),
                scope,
            });
        }
        return Err(TranslationError::Other(format!(
            "{label} API error {}: {}",
            reply.status,
            slice16(err, UPSTREAM_TEXT)
        )));
    }
    Err(TranslationError::Other(format!(
        "{label} request failed: retries exhausted"
    )))
}

// ---- batching ------------------------------------------------------------------------------

/// One-minute fixed windows per `limits.key`.
#[derive(Default)]
pub struct Pacer(HashMap<String, (u64, u64)>);

impl Pacer {
    /// `None` once `tokens` is reserved, else the wait in ms before asking again.
    pub fn try_reserve(&mut self, key: &str, allowance: u64, tokens: u64, now: u64) -> Option<u64> {
        let b = self.0.entry(key.to_owned()).or_insert((now, 0));
        if now.saturating_sub(b.0) >= 60_000 {
            *b = (now, 0);
        }
        if b.1 == 0 || b.1 + tokens <= allowance {
            b.1 += tokens;
            return None;
        }
        Some((b.0 + 60_000).saturating_sub(now))
    }
}

/// What a batch call can come back with.
pub enum BatchError {
    TooLarge(String),
    Other(TranslationError),
}

pub trait Driver: Send {
    /// The translations in order, `None` when the response does not map.
    fn call(
        &mut self,
        texts: &[String],
        max_output_tokens: u64,
    ) -> impl Future<Output = Result<Option<Vec<String>>, BatchError>> + Send;
    fn sleep(&mut self, ms: u64) -> impl Future<Output = ()> + Send;
    fn now_ms(&mut self) -> u64;
    /// `None` once reserved, else the ms to wait (a shared `Pacer`).
    fn reserve(&mut self, key: &str, allowance: u64, tokens: u64, now: u64) -> Option<u64>;
    fn progress(&mut self, _done: usize, _total: usize) {}
    fn warn(&mut self, _message: String) {}
}

fn prompt_tokens(texts: &[String], system: u64) -> u64 {
    texts
        .iter()
        .fold(system, |n, t| n + estimate_tokens(t) + MARKER_TOKENS)
}

pub fn reserve_output(prompt: u64, l: &Limits) -> u64 {
    let room = if l.max_tokens_per_request != 0 {
        l.max_tokens_per_request as i64 - prompt as i64
    } else {
        l.output_ceiling as i64
    };
    256i64.max((l.output_ceiling as i64).min(room).min(prompt as i64 * 2)) as u64
}

pub fn batch_end(texts: &[String], from: usize, system: u64, l: &Limits, ceiling: u64) -> usize {
    let max = (from + ceiling as usize).min(texts.len());
    let budget = if l.max_tokens_per_request != 0 {
        (l.max_tokens_per_request as f64 - system as f64) / 3.0
    } else {
        l.output_ceiling as f64 / 2.0
    };
    let mut used = 0f64;
    for (i, t) in texts.iter().enumerate().take(max).skip(from) {
        used += (estimate_tokens(t) + MARKER_TOKENS) as f64;
        if used > budget && i > from {
            return i;
        }
    }
    max
}

/// Translates `texts` through `driver.call`, splitting on a size rejection or a count mismatch.
pub async fn translate_with_batching<D: Driver>(
    d: &mut D,
    texts: &[String],
    mut limits: Limits,
    system_instruction: &str,
) -> Result<Vec<String>, TranslationError> {
    let system = estimate_tokens(system_instruction);
    if limits.max_tokens_per_request != 0 && limits.max_tokens_per_request < MIN_TOKENS_PER_REQUEST
    {
        d.warn(format!(
            "maxTokensPerRequest={} leaves no room after the system prompt; raising it to {MIN_TOKENS_PER_REQUEST}",
            limits.max_tokens_per_request
        ));
        limits.max_tokens_per_request = MIN_TOKENS_PER_REQUEST;
    }
    let mut ceiling = limits.batch_ceiling.max(1);
    let (mut out, mut done, mut kept) = (Vec::<String>::new(), 0usize, 0usize);
    let mut last_keep: Option<TranslationError> = None;
    let mut mismatches = 0;
    let mut i = 0;
    while i < texts.len() {
        let end = batch_end(texts, i, system, &limits, ceiling);
        // Depth-first over (start, end): the left half finishes before the right one starts.
        let mut stack = vec![(i, end)];
        while let Some((s, e)) = stack.pop() {
            let batch = &texts[s..e];
            if batch.is_empty() {
                continue;
            }
            let prompt = prompt_tokens(batch, system);
            let output = reserve_output(prompt, &limits);
            let mut result = None;
            let mut truncated = false;
            if limits.tokens_per_minute != 0 {
                loop {
                    let now = d.now_ms();
                    let Some(wait) =
                        d.reserve(&limits.key, limits.tokens_per_minute, prompt + output, now)
                    else {
                        break;
                    };
                    d.sleep(wait).await;
                }
            }
            match d.call(batch, output).await {
                Ok(r) => result = r,
                Err(BatchError::Other(e)) => return Err(e),
                Err(BatchError::TooLarge(msg)) => {
                    if batch.len() == 1 {
                        d.warn(format!("{msg}; keeping its source text"));
                        done += 1;
                        d.progress(done, texts.len());
                        kept += 1;
                        last_keep = Some(TranslationError::TooLarge(msg));
                        out.push(batch[0].clone());
                        continue;
                    }
                    d.warn(format!("{msg}; retrying in two halves"));
                    truncated = true;
                    ceiling = ceiling.min((batch.len() / 2) as u64).max(1);
                }
            }
            if let Some(r) = result.filter(|r| r.len() == batch.len()) {
                done += batch.len();
                d.progress(done, texts.len());
                mismatches = 0;
                out.extend(r);
                continue;
            }
            if batch.len() == 1 {
                d.warn("A single cue would not map back; keeping its source text".into());
                mismatches += 1;
                if mismatches >= MAX_CONSECUTIVE_MISMATCHES {
                    return Err(TranslationError::Other(format!(
                        "{MAX_CONSECUTIVE_MISMATCHES} consecutive cues failed to map back to the engine's response, aborting the run"
                    )));
                }
                done += 1;
                d.progress(done, texts.len());
                kept += 1;
                last_keep = Some(TranslationError::Other(
                    "the engine's response did not map back to the source cue".into(),
                ));
                out.push(batch[0].clone());
                continue;
            }
            if !truncated {
                d.warn(format!(
                    "Response did not map back to {} cues, splitting: each half is another request",
                    batch.len()
                ));
            }
            let mid = s + batch.len() / 2;
            stack.push((mid, e));
            stack.push((s, mid));
        }
        i = end;
    }
    if !texts.is_empty() && kept == texts.len() {
        return Err(last_keep.unwrap_or_else(|| {
            TranslationError::Other("translation produced no translated cues".into())
        }));
    }
    Ok(out)
}

/// Resolves the register once per run; a failed or unclear probe leaves it unset.
pub async fn with_register<F, Fut>(
    mut req: Request,
    texts: &[String],
    ask: F,
    mut warn: impl FnMut(String),
) -> Request
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<String, TranslationError>>,
{
    if req.register.is_some() || !has_register_choice(&req.target_language) {
        return req;
    }
    let Some((system, user)) = build_register_probe(&req, &register_sample(texts, 3, 12)) else {
        return req;
    };
    match ask(system, user).await {
        Ok(answer) => match parse_register(&answer, &req.target_language) {
            Some(r) => req.register = Some(r),
            None => warn("Register probe named neither form; leaving it to each segment".into()),
        },
        Err(e) => warn(format!("Register probe failed, continuing without it: {e}")),
    }
    req
}
