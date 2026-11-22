use axum::Router;
use axum::body::{Body, HttpBody, to_bytes};
use axum::extract::{Request, State};
use axum::http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_REQUEST_METHOD, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_TYPE, ETAG, HeaderValue, IF_NONE_MATCH,
};
use axum::http::{Method, StatusCode};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use sha1::{Digest, Sha1};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use super::error::AppError;
use super::static_files::matches_etag;

const WEB_DEFAULT: [&str; 2] = ["http://localhost:4200", "http://localhost:4500"];
const NATIVE: [&str; 3] = [
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
];

/// Origin list: `CORS_ORIGIN` (or the dev defaults) plus the native-app origins.
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

/// Weak ETag from the body of an in-memory `GET /api` JSON 200, and its `If-None-Match` 304.
async fn json_etag(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if req.method() != Method::GET || (path != "/api" && !path.starts_with("/api/")) {
        return next.run(req).await;
    }
    let inm = req.headers().get(IF_NONE_MATCH).cloned();
    let res = next.run(req).await;
    let json = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            let essence = ct.split(';').next().unwrap_or_default().trim();
            essence.eq_ignore_ascii_case("application/json")
        });
    // A streamed body (SSE, exports) has no exact size and is never buffered.
    if res.status() != StatusCode::OK
        || !json
        || res.headers().contains_key(ETAG)
        || res.body().size_hint().exact().is_none()
    {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = to_bytes(body, usize::MAX).await else {
        return AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            .into_response();
    };
    let hex: String = Sha1::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let etag = format!("W/\"{hex}\"");
    parts
        .headers
        .insert(ETAG, HeaderValue::from_str(&etag).expect("ascii etag"));
    parts
        .headers
        .entry(CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("private, no-cache"));
    if inm.is_some_and(|v| matches_etag(v.to_str().unwrap_or_default(), &etag)) {
        parts.status = StatusCode::NOT_MODIFIED;
        parts.headers.remove(CONTENT_TYPE);
        parts.headers.remove(CONTENT_LENGTH);
        return Response::from_parts(parts, Body::empty());
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// The panic itself is logged by `system::logs::log_panics`; the client gets the generic 500.
fn panic_response(_: Box<dyn std::any::Any + Send>) -> Response {
    AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error").into_response()
}

/// A path whose handler reads and bounds its own body.
pub type Exempt = fn(&str) -> bool;

/// The 100 kB limit only covers JSON and urlencoded bodies; uploads and streams are untouched.
async fn body_limit(
    State((limit, exempt)): State<(usize, Exempt)>,
    req: Request,
    next: Next,
) -> Response {
    let limited = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            let essence = ct.split(';').next().unwrap_or_default().trim();
            essence.eq_ignore_ascii_case("application/json")
                || essence.eq_ignore_ascii_case("application/x-www-form-urlencoded")
        });
    // An exempt route reads and bounds its own body, after its own auth.
    if !limited || exempt(req.uri().path()) {
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

pub fn is_preflight(req: &Request) -> bool {
    req.method() == Method::OPTIONS && req.headers().contains_key(ACCESS_CONTROL_REQUEST_METHOD)
}

/// Preflights answer 204 like 4.x (`optionsSuccessStatus`); tower-http answers 200.
async fn preflight_204(req: Request, next: Next) -> Response {
    let preflight = is_preflight(&req);
    let mut res = next.run(req).await;
    if preflight {
        *res.status_mut() = StatusCode::NO_CONTENT;
    }
    res
}

/// The path without the credential of `/kobo/<token>/` and `/cred/<token>/` URLs.
fn redact(path: &str) -> std::borrow::Cow<'_, str> {
    for prefix in ["/kobo/", "/cred/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let tail = rest.find('/').map_or("", |i| &rest[i..]);
            return format!("{prefix}<token>{tail}").into();
        }
    }
    path.into()
}

pub fn apply(
    router: Router,
    cors_origin: Option<String>,
    body_limit_bytes: usize,
    exempt: Exempt,
) -> Router {
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
        .allow_headers(AllowHeaders::mirror_request())
        .expose_headers([CONTENT_RANGE, ACCEPT_RANGES, CONTENT_LENGTH, ETAG]);
    // Media and downloads stay byte-for-byte: already compressed, or served with a length and ranges.
    let compress = DefaultPredicate::new()
        .and(NotForContentType::const_new("video/"))
        .and(NotForContentType::const_new("audio/"))
        .and(NotForContentType::const_new("application/octet-stream"))
        .and(NotForContentType::const_new("application/sql"))
        .and(NotForContentType::const_new("application/zip"))
        .and(NotForContentType::const_new("application/epub"));
    router
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(from_fn_with_state((body_limit_bytes, exempt), body_limit))
        .layer(from_fn(json_etag))
        .layer(from_fn(no_store_on_error))
        .layer(cors)
        .layer(from_fn(preflight_204))
        .layer(CompressionLayer::new().compress_when(compress))
        .layer(TraceLayer::new_for_http().make_span_with(|r: &axum::http::Request<_>| {
            tracing::debug_span!("request", method = %r.method(), path = %redact(r.uri().path()))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use axum::routing::{get, post};
    use tower::ServiceExt;
    use tracing_subscriber::prelude::*;

    async fn boom() -> &'static str {
        panic!("boom-route-test")
    }

    fn app(cors: Option<&str>) -> Router {
        let r = Router::new()
            .route("/ok", get(|| async { "ok" }))
            .route("/err", get(|| async { StatusCode::NOT_FOUND }))
            .route("/panic", get(boom))
            .route("/list", get(|| async { axum::Json(vec!["title"; 64]) }))
            .route(
                "/video",
                get(|| async { ([(CONTENT_TYPE, "video/mp4")], vec![0u8; 4096]) }),
            )
            .route(
                "/epub",
                get(|| async { ([(CONTENT_TYPE, "application/epub+zip")], vec![0u8; 4096]) }),
            )
            .route(
                "/json",
                post(|body: String| async move { body.len().to_string() }),
            );
        apply(r, cors.map(str::to_owned), 100 * 1024, |_| false)
    }

    #[test]
    fn device_tokens_never_reach_the_logs() {
        assert_eq!(
            redact("/kobo/fkd_x/v1/library/sync"),
            "/kobo/<token>/v1/library/sync"
        );
        assert_eq!(
            redact("/cred/fkd_x/api/stream/3"),
            "/cred/<token>/api/stream/3"
        );
        assert_eq!(redact("/kobo/fkd_x"), "/kobo/<token>");
        assert_eq!(redact("/api/items"), "/api/items");
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

    #[tokio::test]
    async fn a_panicking_handler_answers_the_generic_500_and_is_logged() {
        crate::system::logs::log_panics();
        let sub = tracing_subscriber::registry().with(crate::system::logs::RingLayer);
        let _guard = tracing::subscriber::set_default(sub);
        let res = app(None)
            .oneshot(Request::get("/panic").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"statusCode": 500, "message": "Internal server error"})
        );
        assert_eq!(
            crate::system::logs::query("error", "boom-route-test", None).len(),
            1
        );
    }

    #[tokio::test]
    async fn compresses_json_never_media() {
        let get = |path: &str| {
            Request::get(path)
                .header("accept-encoding", "gzip")
                .body(Body::empty())
                .unwrap()
        };
        let list = app(None).oneshot(get("/list")).await.unwrap();
        assert_eq!(list.headers()["content-encoding"], "gzip");
        let video = app(None).oneshot(get("/video")).await.unwrap();
        assert!(video.headers().get("content-encoding").is_none());
        let epub = app(None).oneshot(get("/epub")).await.unwrap();
        assert!(epub.headers().get("content-encoding").is_none());
        assert_eq!(epub.headers()["content-length"], "4096");
    }

    #[tokio::test]
    async fn api_json_gets_a_body_etag_and_304() {
        let r = Router::new()
            .route("/api/list", get(|| async { axum::Json(vec!["title"; 64]) }))
            .route(
                "/api/kept",
                get(|| async { ([(CACHE_CONTROL, "no-store")], axum::Json(1)) }),
            )
            .route(
                "/api/stream",
                get(|| async {
                    let chunks = [Ok::<_, std::io::Error>("[]")];
                    let body = Body::from_stream(futures_util::stream::iter(chunks));
                    ([(CONTENT_TYPE, "application/json")], body)
                }),
            );
        let app = apply(r, None, 1024, |_| false);
        let send = |path: &'static str, inm: Option<String>| {
            let mut b = Request::get(path);
            if let Some(t) = inm {
                b = b.header("if-none-match", t);
            }
            app.clone().oneshot(b.body(Body::empty()).unwrap())
        };
        let first = send("/api/list", None).await.unwrap();
        assert_eq!(first.headers()[CACHE_CONTROL], "private, no-cache");
        let etag = first.headers()[ETAG].to_str().unwrap().to_owned();
        assert!(etag.starts_with("W/\""));
        let hit = send("/api/list", Some(etag)).await.unwrap();
        assert_eq!(hit.status(), 304);
        assert!(
            to_bytes(hit.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
        let kept = send("/api/kept", None).await.unwrap();
        assert_eq!(kept.headers()[CACHE_CONTROL], "no-store");
        assert!(kept.headers().contains_key(ETAG));
        let stream = send("/api/stream", None).await.unwrap();
        assert!(stream.headers().get(ETAG).is_none());
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
        assert_eq!(pre.status(), 204);
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
            send("application/vnd.api+json", big.clone())
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
