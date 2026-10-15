use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use super::error::AppError;
use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, ETAG, IF_NONE_MATCH, LAST_MODIFIED};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use tower_http::services::{ServeDir, ServeFile};

/// Express-style weak ETag (`W/"<size hex>-<mtime ms hex>"`), `Cache-Control` and `If-None-Match` 304.
async fn validators(req: Request, next: Next) -> Response {
    let inm = req.headers().get(IF_NONE_MATCH).cloned();
    let mut res = next.run(req).await;
    let ok = matches!(
        res.status(),
        StatusCode::OK | StatusCode::NOT_MODIFIED | StatusCode::PARTIAL_CONTENT
    );
    if !ok {
        return res;
    }
    res.headers_mut()
        .entry(CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("public, max-age=0"));
    if res.status() != StatusCode::OK {
        return res;
    }
    let len = res
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
    let mtime = res
        .headers()
        .get(LAST_MODIFIED)
        .and_then(|v| httpdate::parse_http_date(v.to_str().ok()?).ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
    let (Some(len), Some(mtime)) = (len, mtime) else {
        return res;
    };
    let etag = format!("W/\"{len:x}-{:x}\"", mtime.as_millis());
    if inm.is_some_and(|v| matches_etag(v.to_str().unwrap_or_default(), &etag)) {
        let headers = res.headers().clone();
        res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        for k in [CACHE_CONTROL, LAST_MODIFIED] {
            if let Some(v) = headers.get(&k) {
                res.headers_mut().insert(k, v.clone());
            }
        }
    }
    res.headers_mut()
        .insert(ETAG, HeaderValue::from_str(&etag).expect("ascii etag"));
    res
}

fn matches_etag(header: &str, etag: &str) -> bool {
    let weak = |t: &str| t.trim().trim_start_matches("W/").to_owned();
    header.trim() == "*" || header.split(',').any(|t| weak(t) == weak(etag))
}

/// `/api/**` never reaches the SPA fallback; every 404 here has Nest's body.
async fn nest_404(req: Request, next: Next) -> Response {
    let (method, path) = (req.method().clone(), req.uri().path().to_owned());
    let res = if path == "/api" || path.starts_with("/api/") {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NOT_FOUND;
        r
    } else {
        next.run(req).await
    };
    if res.status() == StatusCode::NOT_FOUND {
        return AppError::not_found(format!("Cannot {method} {path}")).into_response();
    }
    res
}

pub fn router(client_dir: PathBuf, cast_dir: PathBuf) -> Router {
    let index = client_dir.join("index.html");
    // The SPA fallback must not swallow API paths; those 404 like Nest's `exclude`.
    let spa = ServeDir::new(&client_dir)
        .fallback(ServeFile::new(index))
        .append_index_html_on_directories(true);
    let cast = ServeDir::new(cast_dir).append_index_html_on_directories(false);
    Router::new()
        .nest_service("/cast", cast)
        .fallback_service(spa)
        .layer(from_fn(validators))
        .layer(from_fn(nest_404))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn dirs(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("fliks-http-{tag}-{}", std::process::id()));
        let (client, cast) = (root.join("client"), root.join("cast"));
        std::fs::create_dir_all(&cast).unwrap();
        std::fs::create_dir_all(&client).unwrap();
        std::fs::write(client.join("index.html"), "<html>spa</html>").unwrap();
        std::fs::write(client.join("app.js"), "x=1").unwrap();
        std::fs::write(cast.join("receiver.html"), "cast").unwrap();
        (client, cast)
    }

    async fn get(r: &Router, uri: &str, hdr: Option<(&str, &str)>) -> Response {
        let mut b = Request::get(uri);
        if let Some((k, v)) = hdr {
            b = b.header(k, v);
        }
        r.clone()
            .oneshot(b.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn text(r: Response) -> String {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(b.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn serves_files_spa_cast_and_excludes_api() {
        let (c, k) = dirs("serve");
        let r = router(c, k);
        let file = get(&r, "/app.js", None).await;
        assert_eq!(file.status(), 200);
        assert_eq!(file.headers()[CACHE_CONTROL], "public, max-age=0");
        assert!(file.headers().contains_key(LAST_MODIFIED));
        assert!(file.headers()[ETAG].to_str().unwrap().starts_with("W/\""));
        assert_eq!(text(file).await, "x=1");
        assert_eq!(
            text(get(&r, "/some/route", None).await).await,
            "<html>spa</html>"
        );
        assert_eq!(text(get(&r, "/", None).await).await, "<html>spa</html>");
        assert_eq!(
            text(get(&r, "/cast/receiver.html", None).await).await,
            "cast"
        );
        let missing = get(&r, "/cast/nope.html", None).await;
        assert_eq!(missing.status(), 404);
        assert!(text(missing).await.contains("Cannot GET /cast/nope.html"));
        let api = get(&r, "/api/x", None).await;
        assert_eq!(api.status(), 404);
        assert!(text(api).await.contains("\"statusCode\":404"));
    }

    #[tokio::test]
    async fn conditional_get_304() {
        let (c, k) = dirs("etag");
        let r = router(c, k);
        let etag = get(&r, "/app.js", None).await.headers()[ETAG]
            .to_str()
            .unwrap()
            .to_owned();
        let hit = get(&r, "/app.js", Some(("if-none-match", &etag))).await;
        assert_eq!(hit.status(), 304);
        assert_eq!(hit.headers()[ETAG].to_str().unwrap(), etag);
        assert!(text(hit).await.is_empty());
        let miss = get(&r, "/app.js", Some(("if-none-match", "W/\"0-0\""))).await;
        assert_eq!(miss.status(), 200);
    }
}
