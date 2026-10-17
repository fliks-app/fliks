//! Rust to Nest bridge client (`docs/bridge.md`, plan §6.4): one POST per call, bearer
//! `FLIKS_BRIDGE_TOKEN`; also checks the token of the Rust-side bridges. Removed at S9.
use crate::http::AppError;
use axum::http::{HeaderMap, StatusCode, header::AUTHORIZATION};
use serde_json::{Value, json};
use std::time::Duration;
use subtle::ConstantTimeEq;

#[derive(Debug)]
pub struct BridgeError(String);

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bridge: {}", self.0)
    }
}

impl std::error::Error for BridgeError {}

#[derive(Clone)]
pub struct Bridge {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Bridge {
    /// `base` is Nest's loopback URL; `token` the one given to Nest at spawn.
    pub fn new(base: &str, token: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
        }
    }

    /// 401 unless the request carries `Authorization: Bearer <bridge token>` (constant-time compare).
    pub fn check(&self, headers: &HeaderMap) -> Result<(), AppError> {
        let given = headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default();
        if bool::from(given.as_bytes().ct_eq(self.token.as_bytes())) {
            Ok(())
        } else {
            Err(AppError::bare(StatusCode::UNAUTHORIZED))
        }
    }

    /// One call per committed write with all its keys (non-empty), in order; `origin` unchanged.
    pub async fn settings_changed(
        &self,
        keys: &[String],
        origin: Option<&str>,
    ) -> Result<(), BridgeError> {
        let mut body = json!({"keys": keys});
        if let Some(o) = origin {
            body["origin"] = o.into();
        }
        self.post("settings-changed", body).await
    }

    async fn post(&self, endpoint: &str, body: Value) -> Result<(), BridgeError> {
        let res = self
            .http
            .post(format!("{}/internal/bridge/{endpoint}", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| BridgeError(format!("{endpoint}: {}", e.without_url())))?;
        res.error_for_status()
            .map(drop)
            .map_err(|e| BridgeError(format!("{endpoint}: {}", e.without_url())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
    use std::sync::{Arc, Mutex};

    type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

    async fn fake() -> (Bridge, Seen) {
        let seen: Seen = Arc::default();
        let app = Router::new()
            .route(
                "/internal/bridge/{ep}",
                post(
                    |State(s): State<Seen>,
                     axum::extract::Path(ep): axum::extract::Path<String>,
                     h: HeaderMap,
                     Json(b): Json<Value>| async move {
                        let auth = h
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        s.lock().unwrap().push((ep, auth, b));
                    },
                ),
            )
            .with_state(seen.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        (Bridge::new(&url, "secret"), seen)
    }

    #[tokio::test]
    async fn posts_the_documented_payloads_with_the_bearer() {
        let (b, seen) = fake().await;
        let keys = ["a".to_owned(), "b".to_owned()];
        b.settings_changed(&keys, Some("plugin")).await.unwrap();
        b.settings_changed(&keys[..1], None).await.unwrap();
        let seen = seen.lock().unwrap();
        let bearer = Some("Bearer secret".to_owned());
        let want = [
            (
                "settings-changed",
                json!({"keys": ["a", "b"], "origin": "plugin"}),
            ),
            ("settings-changed", json!({"keys": ["a"]})),
        ];
        for (got, (ep, body)) in seen.iter().zip(want) {
            assert_eq!(got, &(ep.to_owned(), bearer.clone(), body));
        }
        assert_eq!(seen.len(), 2);
    }

    #[tokio::test]
    async fn failures_are_errors_not_panics() {
        assert!(
            Bridge::new("http://127.0.0.1:1", "t")
                .settings_changed(&["k".to_owned()], None)
                .await
                .is_err()
        );
        let app = Router::new().fallback(|| async { axum::http::StatusCode::UNAUTHORIZED });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        assert!(
            Bridge::new(&url, "t")
                .settings_changed(&["k".to_owned()], None)
                .await
                .is_err()
        );
    }

    #[test]
    fn check_accepts_only_the_exact_bearer() {
        let b = Bridge::new("http://x", "secret");
        let with = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(AUTHORIZATION, v.parse().unwrap());
            h
        };
        assert!(b.check(&with("Bearer secret")).is_ok());
        for bad in ["Bearer secre", "Bearer secrets", "secret", "Bearer "] {
            assert!(b.check(&with(bad)).is_err(), "{bad}");
        }
        assert!(b.check(&HeaderMap::new()).is_err());
    }
}
