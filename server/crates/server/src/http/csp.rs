//! Content-Security-Policy on the SPA document, and the endpoint that logs violations.
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{MethodRouter, post};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const HEADER: HeaderName = HeaderName::from_static("content-security-policy");
pub const REPORT_PATH: &str = "/api/csp-report";

/// What the client loads: the Cast sender (gstatic, over the page's own scheme: it loads its
/// framework with a protocol-relative URL), the TMDB art fallback, the YouTube trailer frame.
const POLICY: &str = "default-src 'self'; \
script-src 'self' www.gstatic.com chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfm; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https://image.tmdb.org; \
media-src 'self' blob:; \
font-src 'self' data:; \
connect-src 'self'; \
frame-src https://www.youtube.com; \
worker-src 'self' blob:; \
manifest-src 'self'; \
object-src 'none'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'self'; \
report-uri /api/csp-report";

const MAX_REPORT_BYTES: usize = 8 * 1024;
const MAX_LOGGED_CHARS: usize = 1024;
const WINDOW: Duration = Duration::from_secs(60);
const MAX_PER_WINDOW: u32 = 30;

/// Adds the policy to HTML responses only.
pub async fn on_html(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let html = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    if html {
        res.headers_mut()
            .insert(HEADER, HeaderValue::from_static(POLICY));
    }
    res
}

/// Fixed window shared by every caller: the endpoint is unauthenticated, so one global budget.
struct Budget(Mutex<Option<(Instant, u32)>>);

impl Budget {
    fn take(&self, now: Instant) -> bool {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let w = g.filter(|(t, _)| now.duration_since(*t) < WINDOW);
        let (t, n) = w.unwrap_or((now, 0));
        *g = Some((t, n + 1));
        n < MAX_PER_WINDOW
    }
}

static BUDGET: Budget = Budget(Mutex::new(None));

async fn report(body: Bytes) -> StatusCode {
    if BUDGET.take(Instant::now()) {
        let text: String = String::from_utf8_lossy(&body)
            .chars()
            .take(MAX_LOGGED_CHARS)
            .collect();
        tracing::warn!("csp violation: {text:?}");
    }
    StatusCode::NO_CONTENT
}

/// POST `/api/csp-report`: always 204, nothing echoed back.
pub fn route() -> MethodRouter {
    post(report).layer(DefaultBodyLimit::max(MAX_REPORT_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::middleware::from_fn;
    use tower::ServiceExt;

    #[test]
    fn budget_caps_a_window_then_resets() {
        let b = Budget(Mutex::new(None));
        let t0 = Instant::now();
        assert!((0..MAX_PER_WINDOW).all(|_| b.take(t0)));
        assert!(!b.take(t0));
        assert!(b.take(t0 + WINDOW));
    }

    #[tokio::test]
    async fn policy_on_html_only() {
        let app = Router::new()
            .route(
                "/",
                axum::routing::get(|| async {
                    ([(CONTENT_TYPE, "text/html; charset=utf-8")], "<html/>")
                }),
            )
            .route(
                "/a.js",
                axum::routing::get(|| async { ([(CONTENT_TYPE, "text/javascript")], "x") }),
            )
            .layer(from_fn(on_html));
        let html = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(html.headers()[HEADER], POLICY);
        let js = app
            .oneshot(Request::get("/a.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(!js.headers().contains_key(HEADER));
    }

    #[tokio::test]
    async fn report_is_204_and_capped() {
        let app = Router::new().route(REPORT_PATH, route());
        let send = |len: usize| {
            let app = app.clone();
            async move {
                let req = Request::post(REPORT_PATH)
                    .header(CONTENT_TYPE, "application/csp-report")
                    .body(Body::from(vec![b'a'; len]))
                    .unwrap();
                app.oneshot(req).await.unwrap().status()
            }
        };
        assert_eq!(send(100).await, 204);
        assert_eq!(send(MAX_REPORT_BYTES + 1).await, 413);
    }
}
