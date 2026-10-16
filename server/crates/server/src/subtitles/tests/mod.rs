//! Subtitle tests: provider stubs, routes through the real router, files and engines.
mod files;
mod providers;
mod routes;
mod translation;

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
    pub delay_ms: u64,
}

pub fn reply(status: u16, body: impl Into<Vec<u8>>) -> Reply {
    Reply {
        status,
        headers: vec![],
        body: body.into(),
        delay_ms: 0,
    }
}

pub fn with(mut r: Reply, k: &'static str, v: &str) -> Reply {
    r.headers.push((k, v.to_owned()));
    r
}

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }
}

type Dynamic = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

#[derive(Default)]
struct State_ {
    dynamic: Vec<(String, String, Dynamic)>,
    rules: Vec<(String, String, VecDeque<Reply>)>,
    seen: Vec<Seen>,
}

/// A loopback HTTP stub: replies scripted per method and path (the last reply repeats), every request recorded.
pub struct Stub {
    pub url: String,
    state: Arc<Mutex<State_>>,
}

async fn handle(
    State(s): State<Arc<Mutex<State_>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let seen = Seen {
        method: method.to_string(),
        path: uri.path().to_owned(),
        query: uri.query().unwrap_or("").to_owned(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
            .collect(),
        body: body.to_vec(),
    };
    let (dynamic, r) = {
        let mut st = s.lock().unwrap();
        st.seen.push(seen.clone());
        let dynamic = st
            .dynamic
            .iter()
            .find(|(m, p, _)| *m == method.as_str() && *p == uri.path())
            .map(|(_, _, f)| f.clone());
        let r = if dynamic.is_some() {
            None
        } else {
            st.rules
                .iter_mut()
                .find(|(m, p, _)| *m == method.as_str() && *p == uri.path())
                .map(|(_, _, q)| {
                    if q.len() > 1 {
                        q.pop_front().unwrap()
                    } else {
                        q.front().cloned().unwrap()
                    }
                })
        };
        (dynamic, r)
    };
    if let Some(f) = dynamic {
        return render(f(&seen)).await;
    }
    let Some(r) = r else {
        return Response::builder()
            .status(404)
            .body("no rule".into())
            .unwrap();
    };
    render(r).await
}

async fn render(r: Reply) -> Response {
    if r.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(r.delay_ms)).await;
    }
    let mut b = Response::builder().status(StatusCode::from_u16(r.status).unwrap());
    for (k, v) in &r.headers {
        b = b.header(*k, v);
    }
    b.body(r.body.into()).unwrap()
}

impl Stub {
    pub async fn start() -> Self {
        let state = Arc::new(Mutex::new(State_::default()));
        let app = Router::new()
            .fallback(any(handle))
            .with_state(state.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { url, state }
    }

    pub fn on(&self, method: &str, path: &str, replies: Vec<Reply>) -> &Self {
        self.state
            .lock()
            .unwrap()
            .rules
            .push((method.into(), path.into(), replies.into()));
        self
    }

    /// A reply computed from the request.
    pub fn on_fn(
        &self,
        method: &str,
        path: &str,
        f: impl Fn(&Seen) -> Reply + Send + Sync + 'static,
    ) -> &Self {
        self.state
            .lock()
            .unwrap()
            .dynamic
            .push((method.into(), path.into(), Arc::new(f)));
        self
    }

    pub fn seen(&self, method: &str, path: &str) -> Vec<Seen> {
        self.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|s| s.method == method && s.path == path)
            .cloned()
            .collect()
    }

    pub fn all(&self) -> Vec<Seen> {
        self.state.lock().unwrap().seen.clone()
    }
}

/// A ZIP with one entry, stored (`deflate` false) or deflated.
pub fn zip_of(name: &str, data: &[u8], deflate: bool) -> Vec<u8> {
    let (method, body) = if deflate {
        (8u16, miniz_oxide::deflate::compress_to_vec(data, 6))
    } else {
        (0u16, data.to_vec())
    };
    let mut z = vec![];
    let crc = 0u32;
    let mut local = vec![];
    local.extend_from_slice(b"PK\x03\x04");
    local.extend_from_slice(&[20, 0, 0, 0]);
    local.extend_from_slice(&method.to_le_bytes());
    local.extend_from_slice(&[0, 0, 0, 0]);
    local.extend_from_slice(&crc.to_le_bytes());
    local.extend_from_slice(&(body.len() as u32).to_le_bytes());
    local.extend_from_slice(&(data.len() as u32).to_le_bytes());
    local.extend_from_slice(&(name.len() as u16).to_le_bytes());
    local.extend_from_slice(&[0, 0]);
    local.extend_from_slice(name.as_bytes());
    local.extend_from_slice(&body);
    z.extend_from_slice(&local);
    let mut central = vec![];
    central.extend_from_slice(b"PK\x01\x02");
    central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
    central.extend_from_slice(&method.to_le_bytes());
    central.extend_from_slice(&[0, 0, 0, 0]);
    central.extend_from_slice(&crc.to_le_bytes());
    central.extend_from_slice(&(body.len() as u32).to_le_bytes());
    central.extend_from_slice(&(data.len() as u32).to_le_bytes());
    central.extend_from_slice(&(name.len() as u16).to_le_bytes());
    central.extend_from_slice(&[0; 12]);
    central.extend_from_slice(&0u32.to_le_bytes());
    central.extend_from_slice(name.as_bytes());
    let at = z.len() as u32;
    z.extend_from_slice(&central);
    z.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    z.extend_from_slice(&1u16.to_le_bytes());
    z.extend_from_slice(&1u16.to_le_bytes());
    z.extend_from_slice(&(central.len() as u32).to_le_bytes());
    z.extend_from_slice(&at.to_le_bytes());
    z.extend_from_slice(&[0, 0]);
    z
}

pub const SRT: &str = "1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line.\n";

pub fn fixture(path: &str) -> String {
    let base = std::env::var("CARGO_MANIFEST_DIR").expect("run through cargo test");
    std::fs::read_to_string(format!("{base}/../../fixtures/subtitle-providers/{path}")).unwrap()
}
