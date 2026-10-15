//! Rust to Nest bridge client (`docs/bridge.md`, plan §6.4): one POST per call, bearer
//! `FLIKS_BRIDGE_TOKEN`. Removed with the hub at S2 and the settings listeners at S9.
use serde_json::{Value, json};
use std::time::Duration;

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

    /// `pairing.requested` to the target user's connections only (F13).
    pub async fn pairing_requested(
        &self,
        user_id: i32,
        pairing_id: &str,
        device_name: &str,
        device_id: &str,
    ) -> Result<(), BridgeError> {
        let body = json!({"event": "pairing.requested", "userId": user_id, "pairingId": pairing_id,
            "deviceName": device_name, "deviceId": device_id});
        self.post("emit", body).await
    }

    /// Complete the user's SSE connections; with a non-empty `target_id` only that device's.
    pub async fn drop_connections(
        &self,
        user_id: i32,
        target_id: Option<&str>,
    ) -> Result<(), BridgeError> {
        let mut body = json!({"userId": user_id});
        if let Some(t) = target_id {
            body["targetId"] = t.into();
        }
        self.post("drop-connections", body).await
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
        b.pairing_requested(7, "p1", "TV", "dev").await.unwrap();
        b.drop_connections(3, Some("dev")).await.unwrap();
        b.drop_connections(3, None).await.unwrap();
        let keys = ["a".to_owned(), "b".to_owned()];
        b.settings_changed(&keys, Some("plugin")).await.unwrap();
        b.settings_changed(&keys[..1], None).await.unwrap();
        let seen = seen.lock().unwrap();
        let bearer = Some("Bearer secret".to_owned());
        let want = [
            (
                "emit",
                json!({"event": "pairing.requested", "userId": 7, "pairingId": "p1", "deviceName": "TV", "deviceId": "dev"}),
            ),
            ("drop-connections", json!({"userId": 3, "targetId": "dev"})),
            ("drop-connections", json!({"userId": 3})),
            (
                "settings-changed",
                json!({"keys": ["a", "b"], "origin": "plugin"}),
            ),
            ("settings-changed", json!({"keys": ["a"]})),
        ];
        for (got, (ep, body)) in seen.iter().zip(want) {
            assert_eq!(got, &(ep.to_owned(), bearer.clone(), body));
        }
        assert_eq!(seen.len(), 5);
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
                .drop_connections(1, None)
                .await
                .is_err()
        );
    }
}
