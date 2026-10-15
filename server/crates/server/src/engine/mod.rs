//! Minimal engine client: `hello` only, for `features` on `GET /auth/me` (`auth.md` rule 41).
use fliks_engine_core::api::Hello;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Nest polls hello every 10 s; the answer, or its absence, is reused for as long.
const CACHE: Duration = Duration::from_secs(10);
const TIMEOUT: Duration = Duration::from_secs(2);

/// What this build advertises, and the engine feature each needs (`server-features.ts`).
const SERVER_FEATURES: [(&str, &str); 3] = [
    ("deviceProfileExtensions", "decide"),
    ("hlsSubtitleRequest", "serve"),
    ("muxedAudioRendition", "serve"),
];

type Cached = Option<(Instant, Option<Hello>)>;

#[derive(Clone)]
pub struct Engine {
    http: reqwest::Client,
    url: String,
    token: String,
    last: Arc<Mutex<Cached>>,
}

impl Engine {
    /// `url` empty or `token` empty: no engine, `features()` is always empty.
    pub fn new(url: &str, token: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .expect("reqwest client"),
            url: url.trim().trim_end_matches('/').to_owned(),
            token: token.trim().to_owned(),
            last: Arc::default(),
        }
    }

    /// `GET /v1/hello`; `None` when unconfigured, unreachable or not a 2xx JSON answer. Cached 10 s.
    pub async fn hello(&self) -> Option<Hello> {
        if self.url.is_empty() || self.token.is_empty() {
            return None;
        }
        if let Some((at, h)) = self.last.lock().expect("hello cache").as_ref()
            && at.elapsed() < CACHE
        {
            return h.clone();
        }
        let got = self.fetch().await;
        *self.last.lock().expect("hello cache") = Some((Instant::now(), got.clone()));
        got
    }

    async fn fetch(&self) -> Option<Hello> {
        let res = self
            .http
            .get(format!("{}/v1/hello", self.url))
            .bearer_auth(&self.token)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        res.json().await.ok()
    }

    /// Server features the engine backs; empty when it is down or Nest's adopt gate would refuse it
    /// (protocol below 1, or no `probe`/`capabilities`).
    pub async fn features(&self) -> Vec<&'static str> {
        self.hello()
            .await
            .map_or_else(Vec::new, |h| server_features(&h))
    }
}

fn server_features(h: &Hello) -> Vec<&'static str> {
    let has = |f: &str| h.features.iter().any(|x| x == f);
    if h.protocol_version < 1 || !has("probe") || !has("capabilities") {
        return vec![];
    }
    SERVER_FEATURES
        .iter()
        .filter(|(_, needed)| has(needed))
        .map(|(name, _)| *name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::HeaderMap, routing::get};
    use serde_json::json;

    async fn fake(features: &[&str], protocol: u32) -> Engine {
        let body = json!({"engineVersion": "9", "protocolVersion": protocol, "features": features, "instanceId": "i"});
        let app = Router::new().route(
            "/v1/hello",
            get(move |h: HeaderMap| async move {
                match h.get("authorization").and_then(|v| v.to_str().ok()) {
                    Some("Bearer tok") => Ok(Json(body)),
                    _ => Err(axum::http::StatusCode::UNAUTHORIZED),
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Engine::new(&url, "tok")
    }

    #[tokio::test]
    async fn features_are_filtered_by_what_the_engine_announces() {
        let all = ["probe", "capabilities", "decide", "serve"];
        assert_eq!(
            fake(&all, 1).await.features().await,
            [
                "deviceProfileExtensions",
                "hlsSubtitleRequest",
                "muxedAudioRendition"
            ]
        );
        let e = fake(&["probe", "capabilities", "serve"], 1).await;
        assert_eq!(
            e.features().await,
            ["hlsSubtitleRequest", "muxedAudioRendition"]
        );
        assert!(
            fake(&["probe", "decide"], 1)
                .await
                .features()
                .await
                .is_empty()
        );
        assert!(fake(&all, 0).await.features().await.is_empty());
    }

    #[tokio::test]
    async fn unconfigured_unreachable_or_refused_means_no_features() {
        assert!(Engine::new("", "t").features().await.is_empty());
        assert!(
            Engine::new("http://127.0.0.1:1", "t")
                .features()
                .await
                .is_empty()
        );
        let e = fake(&["probe", "capabilities", "serve"], 1).await;
        let wrong = Engine::new(&e.url, "nope");
        assert!(wrong.features().await.is_empty());
    }
}
