use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use super::error::AppError;

const WEB_DEFAULT: [&str; 2] = ["http://localhost:4200", "http://localhost:4500"];
const NATIVE: [&str; 3] = [
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
];

/// Origin list as Nest builds it: `CORS_ORIGIN` (or the dev defaults) plus the native-app origins.
fn origins(cors_origin: Option<&str>) -> Vec<HeaderValue> {
    let env: Vec<&str> = cors_origin
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .collect();
    let web: &[&str] = if env.is_empty() { &WEB_DEFAULT } else { &env };
    let mut out: Vec<HeaderValue> = Vec::new();
    for o in web.iter().chain(&NATIVE) {
        if let Ok(v) = HeaderValue::from_str(o)
            && !out.contains(&v)
        {
            out.push(v);
        }
    }
    out
}

async fn no_store_on_error(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.status().as_u16() >= 400 {
        res.headers_mut().insert(
            CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        );
    }
    res
}

/// Express's 100 kB limit only covers JSON and urlencoded bodies; uploads and streams are untouched.
async fn body_limit(State(limit): State<usize>, req: Request, next: Next) -> Response {
    let limited = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            let ct = ct.to_ascii_lowercase();
            ct.contains("json") || ct.starts_with("application/x-www-form-urlencoded")
        });
    if !limited {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    match to_bytes(body, limit).await {
        Ok(bytes) => {
            next.run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
        Err(_) => AppError::plain(StatusCode::PAYLOAD_TOO_LARGE, "request entity too large")
            .into_response(),
    }
}

pub fn apply(router: Router, cors_origin: Option<String>, body_limit_bytes: usize) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins(cors_origin.as_deref())))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::PUT,
            Method::PATCH,
            Method::POST,
            Method::DELETE,
        ])
        .allow_headers(AllowHeaders::mirror_request());
    router
        .layer(from_fn_with_state(body_limit_bytes, body_limit))
        .layer(from_fn(no_store_on_error))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use axum::routing::{get, post};
    use tower::ServiceExt;

    fn app(cors: Option<&str>) -> Router {
        let r = Router::new()
            .route("/ok", get(|| async { "ok" }))
            .route("/err", get(|| async { StatusCode::NOT_FOUND }))
            .route(
                "/json",
                post(|body: String| async move { body.len().to_string() }),
            );
        apply(r, cors.map(str::to_owned), 100 * 1024)
    }

    #[tokio::test]
    async fn no_store_only_on_errors() {
        let ok = app(None)
            .oneshot(Request::get("/ok").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(ok.headers().get(CACHE_CONTROL).is_none());
        let err = app(None)
            .oneshot(Request::get("/err").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            err.headers()[CACHE_CONTROL],
            "no-store, no-cache, must-revalidate"
        );
    }

    #[test]
    fn origin_parsing() {
        let s = |v: Vec<HeaderValue>| {
            v.iter()
                .map(|h| h.to_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            s(origins(Some(" https://a.test , ,https://localhost"))),
            [
                "https://a.test",
                "https://localhost",
                "capacitor://localhost",
                "http://localhost"
            ]
        );
        assert_eq!(s(origins(Some(" , "))).len(), 5);
        assert_eq!(s(origins(None))[0], "http://localhost:4200");
    }

    #[tokio::test]
    async fn cors_preflight_and_reflection() {
        let pre = app(Some("https://a.test"))
            .oneshot(
                Request::options("/ok")
                    .header("origin", "https://a.test")
                    .header("access-control-request-method", "PUT")
                    .header("access-control-request-headers", "x-custom")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let h = pre.headers();
        assert_eq!(h["access-control-allow-origin"], "https://a.test");
        assert_eq!(h["access-control-allow-credentials"], "true");
        assert_eq!(h["access-control-allow-headers"], "x-custom");
        let bad = app(Some("https://a.test"))
            .oneshot(
                Request::get("/ok")
                    .header("origin", "https://evil.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(bad.headers().get("access-control-allow-origin").is_none());
    }

    #[tokio::test]
    async fn body_limit_json_only() {
        let big = "x".repeat(100 * 1024 + 1);
        let send = |ct: &str, body: String| {
            let req = Request::post("/json")
                .header("content-type", ct)
                .body(Body::from(body))
                .unwrap();
            app(None).oneshot(req)
        };
        let res = send("application/json", big.clone()).await.unwrap();
        assert_eq!(res.status(), 413);
        let b = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&b).unwrap(),
            serde_json::json!({"statusCode": 413, "message": "request entity too large"})
        );
        assert_eq!(
            send("application/json", "x".repeat(100 * 1024))
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            send("application/octet-stream", big)
                .await
                .unwrap()
                .status(),
            200
        );
    }
}
