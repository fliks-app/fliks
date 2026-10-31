//! Translation core vectors (`fixtures/translation/cases.json`): retry, batching, prompts, register.
mod common;

use common::replay;
use fliks_domain::media::kind::MediaKind;
use fliks_domain::translation::*;
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::pin,
    task::{Context as Cx, Poll, Waker},
};

fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Cx::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn name(e: &TranslationError) -> &'static str {
    match e {
        TranslationError::RateLimit { .. } => "TranslationRateLimitError",
        TranslationError::TooLarge(_) => "TranslationPayloadTooLargeError",
        TranslationError::Other(_) => "Error",
    }
}

struct Scripted {
    script: Vec<Value>,
    calls: usize,
    sleeps: Vec<u64>,
}

impl Post for Scripted {
    type Resp = u16;
    async fn send(&mut self) -> Attempt<u16> {
        let s = self.script[self.calls.min(self.script.len() - 1)].clone();
        self.calls += 1;
        if let Some(m) = s["throw"].as_str() {
            return Attempt::Network(format!("Error: {m}"));
        }
        let status = s["status"].as_u64().unwrap_or(200) as u16;
        if status == 200 {
            return Attempt::Ok(200);
        }
        Attempt::Failed(Reply {
            status,
            retry_after: s["headers"]["retry-after"].as_str().map(str::to_owned),
            body: s["body"].as_str().unwrap_or("").to_owned(),
        })
    }
    async fn sleep(&mut self, ms: u64) {
        self.sleeps.push(ms);
    }
}

fn expand(spec: &Value) -> String {
    let (len, kind, bad) = (
        spec[0].as_u64().unwrap() as usize,
        spec[1].as_u64().unwrap(),
        spec[2].as_u64().unwrap() == 1,
    );
    let unit = ["x", "😀", "é"][kind as usize];
    let mut t = String::new();
    while t.encode_utf16().count() < len {
        t += unit;
    }
    if bad {
        t += "BAD";
    }
    t
}

struct Mock<'a> {
    case: &'a Value,
    now: u64,
    k: u64,
    calls: Vec<Value>,
    progress: Vec<Value>,
    sleeps: Vec<u64>,
    pacer: Pacer,
}

impl Driver for Mock<'_> {
    async fn call(
        &mut self,
        texts: &[String],
        max: u64,
    ) -> Result<Option<Vec<String>>, BatchError> {
        self.k += 1;
        self.calls.push(json!({
            "len": texts.len(),
            "firstLen": texts.first().map(|t| t.encode_utf16().count()),
            "max": max,
            "t": self.now,
        }));
        let arg = self.case["modeArg"].as_u64().unwrap();
        let ok = |t: &[String]| Ok(Some(t.iter().map(|x| format!("T:{x}")).collect()));
        let est = |t: &[String]| t.iter().map(|x| estimate_tokens(x)).sum::<u64>();
        match self.case["mode"].as_str().unwrap() {
            "echo" => ok(texts),
            "tooLargeOver" if texts.len() as u64 > arg => {
                Err(BatchError::TooLarge(format!("big {}", texts.len())))
            }
            "mismatchOver" if texts.len() as u64 > arg => Ok(None),
            "dropLastOver" if texts.len() as u64 > arg => ok(&texts[1..]),
            "mismatchContainsBad" if texts.iter().any(|t| t.contains("BAD")) => Ok(None),
            "badAlways" => Ok(None),
            "tooLargeAlways" => Err(BatchError::TooLarge("always".into())),
            "errorAt" if self.k == arg => {
                Err(BatchError::Other(TranslationError::Other("boom".into())))
            }
            "tooLargeTokens" if est(texts) > arg => Err(BatchError::TooLarge("tokens".into())),
            _ => ok(texts),
        }
    }
    async fn sleep(&mut self, ms: u64) {
        self.sleeps.push(ms);
        self.now += ms;
    }
    fn now_ms(&mut self) -> u64 {
        self.now
    }
    fn reserve(&mut self, key: &str, allowance: u64, tokens: u64, now: u64) -> Option<u64> {
        self.pacer.try_reserve(key, allowance, tokens, now)
    }
    fn progress(&mut self, done: usize, total: usize) {
        self.progress.push(json!([done, total]));
    }
}

fn request(v: &Value) -> Request {
    let c = &v["context"];
    Request {
        source_language: v["sourceLanguage"].as_str().unwrap().into(),
        target_language: v["targetLanguage"].as_str().unwrap().into(),
        register: v["register"].as_str().map(str::to_owned),
        context: Context {
            title: c["title"].as_str().map(str::to_owned),
            year: c["year"].as_i64(),
            media_type: c["mediaType"].as_str().and_then(MediaKind::parse),
            genres: c["genres"]
                .as_array()
                .map(|g| g.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
                .unwrap_or_default(),
            overview: c["overview"].as_str().map(str::to_owned),
        },
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

fn run(i: &Value) -> Value {
    match i["fn"].as_str().unwrap() {
        "postWithRetry" => {
            let mut p = Scripted {
                script: i["script"].as_array().unwrap().clone(),
                calls: 0,
                sleeps: vec![],
            };
            match block_on(post_with_retry(&mut p, "Label")) {
                Ok(status) => {
                    json!({"ok": true, "status": status, "calls": p.calls, "sleeps": p.sleeps})
                }
                Err(e) => {
                    let scope = match &e {
                        TranslationError::RateLimit { scope, .. } => json!(scope.as_str()),
                        _ => Value::Null,
                    };
                    let mut err = json!({"name": name(&e), "message": e.to_string()});
                    if !scope.is_null() {
                        err["scope"] = scope;
                    }
                    json!({"error": err, "calls": p.calls, "sleeps": p.sleeps})
                }
            }
        }
        "translateWithBatching" => {
            let l = &i["limits"];
            let limits = Limits {
                max_tokens_per_request: l["maxTokensPerRequest"].as_u64().unwrap(),
                tokens_per_minute: l["tokensPerMinute"].as_u64().unwrap(),
                key: l["key"].as_str().unwrap().into(),
                output_ceiling: l["outputCeiling"].as_u64().unwrap(),
                batch_ceiling: l["batchCeiling"].as_u64().unwrap(),
            };
            let texts: Vec<String> = i["texts"].as_array().unwrap().iter().map(expand).collect();
            let mut d = Mock {
                case: i,
                now: 1_000_000,
                k: 0,
                calls: vec![],
                progress: vec![],
                sleeps: vec![],
                pacer: Pacer::default(),
            };
            let system = "x".repeat(i["systemLen"].as_u64().unwrap() as usize);
            let out = match block_on(translate_with_batching(&mut d, &texts, limits, &system)) {
                Ok(r) => json!({"result": r}),
                Err(e) => json!({"error": {"name": name(&e), "message": e.to_string()}}),
            };
            let mut out = out;
            out["calls"] = json!(d.calls);
            out["progress"] = json!(d.progress);
            out["sleeps"] = json!(d.sleeps);
            out
        }
        "buildSystemInstruction" => json!(build_system_instruction(&request(&i["req"]))),
        "buildRegisterProbe" => {
            match build_register_probe(&request(&i["req"]), &strings(&i["sample"])) {
                Some((system, user)) => json!({"system": system, "user": user}),
                None => Value::Null,
            }
        }
        "parseRegister" => json!(parse_register(
            i["answer"].as_str().unwrap(),
            i["target"].as_str().unwrap()
        )),
        "registerSample" => json!(register_sample(
            &strings(&i["texts"]),
            i["windows"].as_u64().unwrap() as usize,
            i["perWindow"].as_u64().unwrap() as usize
        )),
        "parseNumbered" => json!(parse_numbered(
            i["response"].as_str().unwrap(),
            i["count"].as_u64().unwrap() as usize
        )),
        "buildPayload" => json!(build_payload(&strings(&i["texts"]))),
        "estimateTokens" => json!(estimate_tokens(i["text"].as_str().unwrap())),
        _ => {
            let mut asks = vec![];
            let fail = i["fail"].as_bool().unwrap();
            let answer = i["answer"].as_str().unwrap().to_owned();
            let req = block_on(with_register(
                request(&i["req"]),
                &strings(&i["texts"]),
                |system, user| {
                    asks.push(json!({"system": system, "user": user}));
                    async move {
                        if fail {
                            Err(TranslationError::Other("down".into()))
                        } else {
                            Ok(answer)
                        }
                    }
                },
                |_| {},
            ));
            json!({"register": req.register, "asks": asks})
        }
    }
}

#[test]
fn translation_reproduces_expected() {
    replay("translation", 1626, run);
}
