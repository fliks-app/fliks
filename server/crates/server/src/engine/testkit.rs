//! A fake engine (axum on a loopback port) that records what the host sends and plays scripted answers.
use crate::sync::MutexExt;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

/// One scripted reply; the last of a queue repeats.
#[derive(Clone)]
pub struct Answer {
    pub status: u16,
    pub body: Option<Value>,
    pub headers: Vec<(&'static str, String)>,
    pub delay_ms: u64,
}

pub fn ok(body: Value) -> Answer {
    Answer {
        status: 200,
        body: Some(body),
        headers: vec![],
        delay_ms: 0,
    }
}

pub fn slow(delay_ms: u64, mut a: Answer) -> Answer {
    a.delay_ms = delay_ms;
    a
}

pub fn status(status: u16) -> Answer {
    Answer {
        status,
        body: None,
        headers: vec![],
        delay_ms: 0,
    }
}

pub fn retry_after(status: u16, secs: &str) -> Answer {
    Answer {
        headers: vec![("retry-after", secs.into())],
        ..self::status(status)
    }
}

pub fn coded(status: u16, code: &str) -> Answer {
    Answer {
        body: Some(json!({"code": code})),
        ..self::status(status)
    }
}

/// What one `GET /v1/events` connection does.
pub enum Conn {
    /// A non-2xx answer.
    Refuse(u16),
    /// Frames, then stay open silently.
    Hold(Vec<String>),
    /// Frames, then end the stream.
    End(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Seen {
    pub auth: String,
    pub content_type: Option<String>,
    pub query: String,
    pub body: Value,
}

#[derive(Default)]
struct S {
    hello: Option<Value>,
    answers: HashMap<String, VecDeque<Answer>>,
    seen: HashMap<String, Vec<Seen>>,
    conns: VecDeque<Conn>,
    connected_at: Vec<Instant>,
    held: Vec<mpsc::UnboundedSender<Result<Bytes, Infallible>>>,
    order: Vec<String>,
}

pub struct Fake {
    pub url: String,
    s: Arc<Mutex<S>>,
}

pub const FEATURES: [&str; 3] = ["probe", "capabilities", "decide"];
pub const RUNTIME: [&str; 7] = [
    "probe",
    "capabilities",
    "decide",
    "sessions",
    "serve",
    "events",
    "session-replaces",
];

pub fn hello_body(features: &[&str], instance: &str) -> Value {
    json!({"engineVersion": "0.2.0", "protocolVersion": 1, "features": features, "instanceId": instance})
}

impl Fake {
    pub async fn start() -> Self {
        let s: Arc<Mutex<S>> = Arc::new(Mutex::new(S {
            hello: Some(hello_body(&FEATURES, "x")),
            ..S::default()
        }));
        let app = Router::new().fallback(handle).with_state(s.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { url, s }
    }

    /// The `hello` answer; `None` makes the engine answer 500, which the host takes as "not there".
    pub fn hello(&self, body: Option<Value>) {
        self.s.lock_clean().hello = body;
    }

    pub fn script(&self, method: &str, path: &str, answers: Vec<Answer>) {
        self.s
            .lock_clean()
            .answers
            .insert(format!("{method} {path}"), answers.into());
    }

    pub fn connections(&self, conns: Vec<Conn>) {
        self.s.lock_clean().conns = conns.into();
    }

    pub fn seen(&self, method: &str, path: &str) -> Vec<Seen> {
        let s = self.s.lock_clean();
        s.seen
            .get(&format!("{method} {path}"))
            .cloned()
            .unwrap_or_default()
    }

    /// When each `GET /v1/events` connection arrived.
    pub fn connected_at(&self) -> Vec<Instant> {
        self.s.lock_clean().connected_at.clone()
    }

    /// Every request in arrival order, as `METHOD /path`.
    pub fn order(&self) -> Vec<String> {
        self.s.lock_clean().order.clone()
    }

    /// Writes raw SSE text to every open (held) events connection.
    pub fn push_frames(&self, text: &str) {
        let s = self.s.lock_clean();
        for tx in &s.held {
            let _ = tx.send(Ok(Bytes::from(text.to_owned())));
        }
    }
}

fn json_response(a: &Answer) -> Response {
    let mut res = Response::builder().status(a.status);
    for (k, v) in &a.headers {
        res = res.header(*k, v);
    }
    match &a.body {
        Some(b) => res
            .header("content-type", "application/json")
            .body(Body::from(b.to_string())),
        None => res.body(Body::empty()),
    }
    .unwrap()
}

fn sse(s: &mut S, frames: Vec<String>, hold: bool) -> Response {
    let (tx, rx) = mpsc::unbounded_channel();
    for f in frames {
        let _ = tx.send(Ok(Bytes::from(f)));
    }
    if hold {
        s.held.push(tx);
    }
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .unwrap()
}

async fn handle(State(s): State<Arc<Mutex<S>>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    let key = format!("{} {}", parts.method, parts.uri.path());
    let seen = Seen {
        auth: parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
        content_type: parts
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        query: parts.uri.query().unwrap_or_default().to_owned(),
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    };
    let (response, delay_ms) = {
        let mut s = s.lock_clean();
        s.order.push(key.clone());
        s.seen.entry(key.clone()).or_default().push(seen);
        respond(&mut s, &key, &bytes)
    };
    if delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
    response
}

/// A `"$field"` string in a scripted body is replaced by that field of the request body.
fn echo(v: &mut Value, req: &Value) {
    match v {
        Value::String(t) => {
            if let Some(f) = t.strip_prefix('$') {
                *v = req.get(f).cloned().unwrap_or(Value::Null);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| echo(x, req)),
        Value::Object(o) => o.values_mut().for_each(|x| echo(x, req)),
        _ => {}
    }
}

fn respond(s: &mut S, key: &str, req: &[u8]) -> (Response, u64) {
    if key == "GET /v1/events" {
        s.connected_at.push(Instant::now());
        let res = match s.conns.pop_front() {
            Some(Conn::Refuse(code)) => json_response(&status(code)),
            Some(Conn::Hold(frames)) => sse(s, frames, true),
            Some(Conn::End(frames)) => sse(s, frames, false),
            None => json_response(&status(503)),
        };
        return (res, 0);
    }
    if let Some(q) = s.answers.get_mut(key) {
        let a = if q.len() > 1 {
            q.pop_front()
        } else {
            q.front().cloned()
        }
        .expect("a scripted answer");
        let mut a = a;
        if let Some(b) = a.body.as_mut() {
            echo(b, &serde_json::from_slice(req).unwrap_or(Value::Null));
        }
        return (json_response(&a), a.delay_ms);
    }
    let res = match key {
        "GET /v1/hello" => match &s.hello {
            Some(h) => json_response(&ok(h.clone())),
            None => json_response(&status(500)),
        },
        "GET /v1/config" => json_response(&ok(json!({"revision": 7}))),
        "PUT /v1/config" => json_response(&ok(json!({}))),
        _ => {
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::NOT_FOUND;
            res.headers_mut()
                .insert("x-fake", HeaderValue::from_static("unscripted"));
            res
        }
    };
    (res, 0)
}
