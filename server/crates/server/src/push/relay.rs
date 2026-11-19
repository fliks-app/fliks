//! The signed client of the Fliks relay (`PROTOCOL.md` of the relay repo): requests, tickets, clock offset.
use super::identity::hex;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ed25519_dalek::{Signer, SigningKey};
use reqwest::{Method, Url, header};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::atomic::{AtomicBool, AtomicI64, Ordering},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(10);
const TICKET_TTL: i64 = 300;

#[derive(Debug)]
pub enum Error {
    Net(String),
    Status {
        status: u16,
        code: String,
        scope: Option<String>,
    },
}

impl Error {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Status { code, .. } => Some(code),
            Self::Net(_) => None,
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            Self::Net(_) => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Net(e) => write!(f, "{e}"),
            Self::Status {
                status,
                code,
                scope: Some(s),
            } => write!(f, "relay answered {status} {code} ({s})"),
            Self::Status { status, code, .. } => write!(f, "relay answered {status} {code}"),
        }
    }
}

pub fn key_of_seed(seed_hex: &str) -> Option<String> {
    let seed: [u8; 32] = super::identity::unhex(seed_hex)?.try_into().ok()?;
    Some(key_of(&SigningKey::from_bytes(&seed)))
}

pub fn key_of(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_bytes())
}

/// The `HOST` the relay signs for: its authority, the port only when it is not the scheme default.
pub fn canonical_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    url.port()
        .map_or_else(|| host.to_owned(), |p| format!("{host}:{p}"))
}

pub fn signed_string(method: &str, host: &str, path: &str, time: i64, body: &[u8]) -> String {
    format!(
        "fliks-relay-v1\n{method}\n{host}\n{path}\n{time}\n{}",
        hex(&Sha256::digest(body))
    )
}

pub fn sign(
    key: &SigningKey,
    method: &str,
    host: &str,
    path: &str,
    time: i64,
    body: &[u8],
) -> String {
    let s = signed_string(method, host, path, time, body);
    B64.encode(key.sign(s.as_bytes()).to_bytes())
}

#[derive(Serialize)]
struct Claims<'a> {
    key: &'a str,
    sub: &'a str,
    aud: &'a str,
    exp: i64,
}

pub fn ticket(key: &SigningKey, sub: &str, aud: &str, exp: i64) -> String {
    let body = serde_json::to_vec(&Claims {
        key: &key_of(key),
        sub,
        aud,
        exp,
    })
    .expect("typed claims");
    let part = B64.encode(body);
    let sig = key.sign(format!("fliks-relay-ticket-v1\n{part}").as_bytes());
    format!("{part}.{}", B64.encode(sig.to_bytes()))
}

pub struct Relay {
    http: reqwest::Client,
    base: String,
    path_prefix: String,
    host: String,
    key: SigningKey,
    offset: AtomicI64,
    synced: AtomicBool,
}

fn unix() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Relay {
    pub fn new(url: &str, seed_hex: &str) -> Result<Self, String> {
        let parsed = Url::parse(url).map_err(|e| format!("bad relay URL: {e}"))?;
        let seed: [u8; 32] = super::identity::unhex(seed_hex)
            .and_then(|b| b.try_into().ok())
            .ok_or("bad relay seed")?;
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent("fliks-server")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            base: format!(
                "{}://{}",
                parsed.scheme(),
                parsed
                    .host_str()
                    .map(|_| parsed.authority())
                    .unwrap_or_default()
            ),
            path_prefix: parsed.path().trim_end_matches('/').to_owned(),
            host: canonical_host(&parsed),
            key: SigningKey::from_bytes(&seed),
            offset: AtomicI64::new(0),
            synced: AtomicBool::new(false),
        })
    }

    pub fn key(&self) -> String {
        key_of(&self.key)
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    fn now(&self) -> i64 {
        unix() + self.offset.load(Ordering::Relaxed)
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        signed: bool,
    ) -> Result<Value, Error> {
        let mut retried = false;
        loop {
            let raw = body
                .as_ref()
                .map(|b| serde_json::to_vec(b).expect("json value"))
                .unwrap_or_default();
            let full = format!("{}{path}", self.path_prefix);
            let mut req = self
                .http
                .request(method.clone(), format!("{}{full}", self.base));
            if signed {
                let time = self.now();
                req = req
                    .header("Fliks-Key", self.key())
                    .header("Fliks-Time", time.to_string())
                    .header(
                        "Fliks-Signature",
                        sign(&self.key, method.as_str(), &self.host, &full, time, &raw),
                    );
            }
            if body.is_some() {
                req = req
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(raw);
            }
            let res = req.send().await.map_err(|e| Error::Net(net_text(e)))?;
            if let Some(date) = res
                .headers()
                .get(header::DATE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| httpdate::parse_http_date(v).ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            {
                self.offset
                    .store(date.as_secs() as i64 - unix(), Ordering::Relaxed);
                self.synced.store(true, Ordering::Relaxed);
            }
            let status = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status < 300 {
                return Ok(value);
            }
            let code = value["error"].as_str().unwrap_or("").to_owned();
            if status == 401 && code == "clock_skew" && !retried {
                retried = true;
                continue;
            }
            return Err(Error::Status {
                status,
                code,
                scope: value["scope"].as_str().map(str::to_owned),
            });
        }
    }

    /// `GET /v1/info`; also learns the relay's clock.
    pub async fn info(&self) -> Result<Value, Error> {
        self.call(Method::GET, "/v1/info", None, false).await
    }

    pub async fn register(&self) -> Result<(), Error> {
        self.call(Method::POST, "/v1/servers", Some(json!({})), true)
            .await
            .map(drop)
    }

    pub async fn delete_self(&self) -> Result<(), Error> {
        self.call(Method::DELETE, "/v1/servers/self", None, true)
            .await
            .map(drop)
    }

    pub async fn stats(&self) -> Result<Value, Error> {
        self.call(Method::GET, "/v1/servers/self/stats", None, true)
            .await
    }

    pub async fn delete_subscription(&self, sub: &str) -> Result<(), Error> {
        self.call(
            Method::DELETE,
            &format!("/v1/subscriptions/{sub}"),
            None,
            true,
        )
        .await
        .map(drop)
    }

    pub async fn push(&self, nid: &str, sub: &str, payload: &[u8], ttl: u32) -> Result<(), Error> {
        let body = json!({"nid": nid, "sub": sub, "payload": B64.encode(payload), "ttl": ttl});
        self.call(Method::POST, "/v1/push", Some(body), true)
            .await
            .map(drop)
    }

    /// A ticket for `sub` on the relay's clock, which is learned first when never contacted.
    pub async fn ticket(&self, sub: &str) -> Result<String, Error> {
        if !self.synced.load(Ordering::Relaxed) {
            self.info().await?;
        }
        Ok(ticket(&self.key, sub, &self.host, self.now() + TICKET_TTL))
    }
}

/// Transport error text without the URL.
fn net_text(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("timeout of {}ms exceeded", TIMEOUT.as_millis());
    }
    e.without_url().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/push/relay-vectors.json")).unwrap()
    }

    fn key(v: &Value) -> SigningKey {
        let seed =
            super::super::identity::unhex(v["server"]["seed_hex"].as_str().unwrap()).unwrap();
        SigningKey::from_bytes(&seed.try_into().unwrap())
    }

    #[test]
    fn signs_the_relay_vectors() {
        let v = vectors();
        let k = key(&v);
        assert_eq!(key_of(&k), v["server"]["public_key"]);
        let all = v["requests"]
            .as_array()
            .unwrap()
            .iter()
            .chain([&v["request_wrong_host"]]);
        for r in all {
            let (host, path, body) = (
                r["host"].as_str().unwrap(),
                r["path"].as_str().unwrap(),
                r["body"].as_str().unwrap(),
            );
            let time = r["time"].as_i64().unwrap();
            let method = r["method"].as_str().unwrap();
            assert_eq!(
                signed_string(method, host, path, time, body.as_bytes()),
                r["signed_string"]
            );
            assert_eq!(
                sign(&k, method, host, path, time, body.as_bytes()),
                r["signature"]
            );
        }
    }

    #[test]
    fn mints_the_vector_ticket() {
        let v = vectors();
        let t = &v["tickets"]["valid"];
        let got = ticket(
            &key(&v),
            t["sub"].as_str().unwrap(),
            t["aud"].as_str().unwrap(),
            t["exp"].as_i64().unwrap(),
        );
        assert_eq!(got, t["ticket"]);
    }

    #[test]
    fn canonical_host_keeps_a_non_default_port() {
        let h = |u: &str| canonical_host(&Url::parse(u).unwrap());
        assert_eq!(h("https://relay.example.test/"), "relay.example.test");
        assert_eq!(h("http://localhost:8080"), "localhost:8080");
    }
}
