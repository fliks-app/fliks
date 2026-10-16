//! One upstream: a `reqwest` client behind the shared circuit breaker (`metadata.md` rules 18, 20, 21).
use fliks_domain::metadata::breaker::{Breaker, Event, Outcome};
use serde_json::Value;
use std::{error::Error, sync::Mutex, time::Duration, time::Instant};

/// A failed upstream call; `reason` never contains the request URL (rule 21).
#[derive(Debug, Clone)]
pub struct Upstream {
    pub status: Option<u16>,
    reason: String,
}

impl Upstream {
    pub fn new(status: Option<u16>, reason: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn is_not_found(&self) -> bool {
        self.status == Some(404)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }
}

impl std::fmt::Display for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

/// The axios code name of a transport failure, `network error` when unknown.
fn code_of(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        return "ECONNABORTED";
    }
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return "ECONNREFUSED",
                std::io::ErrorKind::ConnectionReset => return "ECONNRESET",
                _ => {}
            }
        }
        if s.to_string().contains("dns error") {
            return "ENOTFOUND";
        }
        src = s.source();
    }
    "network error"
}

/// The transport failure as `<code> — <message>` with every source of the chain, URL stripped.
pub fn transport(e: reqwest::Error) -> Upstream {
    let code = code_of(&e);
    let e = e.without_url();
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    Upstream::new(None, format!("{code} — {msg}"))
}

/// `HTTP <status> — <status_message|message|default>` as the controller words it.
pub fn http_reason(status: u16, body: &Value) -> String {
    let said = ["status_message", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Request failed with status code {status}"));
    format!("HTTP {status} — {said}")
}

pub struct Guarded {
    name: &'static str,
    base: String,
    client: reqwest::Client,
    breaker: Mutex<Breaker>,
    started: Instant,
    /// Query parameters sent on every request (TMDB's `api_key`).
    fixed: Vec<(String, String)>,
}

impl Guarded {
    pub fn new(
        name: &'static str,
        base: &str,
        timeout: Duration,
        fixed: Vec<(String, String)>,
    ) -> Self {
        Self {
            name,
            base: base.trim_end_matches('/').to_owned(),
            client: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("reqwest client"),
            breaker: Mutex::new(Breaker::new(3, 30_000)),
            started: Instant::now(),
            fixed,
        }
    }

    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn record(&self, outcome: Outcome) {
        let event = self
            .breaker
            .lock()
            .expect("breaker")
            .record(self.now(), outcome);
        match event {
            Event::Opened => tracing::warn!(
                "{}: 3 consecutive failures, circuit open for 30s",
                self.name
            ),
            Event::Recovered => tracing::info!("{}: upstream recovered, circuit closed", self.name),
            Event::None => {}
        }
    }

    pub fn get(&self, path: &str, query: &[(String, String)]) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{path}", self.base))
            .query(&self.fixed)
            .query(query)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.post(format!("{}{path}", self.base))
    }

    /// Sends the request through the breaker and returns the 2xx JSON body.
    pub async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, Upstream> {
        let allowed = {
            let mut b = self.breaker.lock().expect("breaker");
            b.allow(self.now())
        };
        if !allowed {
            return Err(Upstream::new(
                None,
                format!(
                    "{} circuit open — upstream temporarily unreachable",
                    self.name
                ),
            ));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                self.record(Outcome::Transient);
                return Err(transport(e));
            }
        };
        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            self.record(Outcome::of_status(status));
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(Upstream::new(Some(status), http_reason(status, &body)));
        }
        self.record(Outcome::Ok);
        resp.json()
            .await
            .map_err(|_| Upstream::new(Some(status), "invalid JSON response"))
    }

    pub async fn get_json(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value, Upstream> {
        self.send(self.get(path, query)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons() {
        let body = serde_json::json!({"status_message": "Invalid API key"});
        assert_eq!(http_reason(401, &body), "HTTP 401 — Invalid API key");
        assert_eq!(
            http_reason(500, &Value::Null),
            "HTTP 500 — Request failed with status code 500"
        );
        let body = serde_json::json!({"message": "nope"});
        assert_eq!(http_reason(404, &body), "HTTP 404 — nope");
    }
}
