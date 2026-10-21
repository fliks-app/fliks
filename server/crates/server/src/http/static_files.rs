use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use super::error::AppError;
use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH, LAST_MODIFIED,
};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use tower_http::services::{ServeDir, ServeFile};

/// Weak ETag (`W/"<size hex>-<mtime seconds hex>"`, as 4.x), `Cache-Control` and `If-None-Match` 304.
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
    add_charset(&mut res);
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
    let etag = weak_etag(len, mtime.as_secs());
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

/// `mime-types` rule of 4.x: lowercase `utf-8` on `text/*`, JavaScript and JSON.
fn add_charset(res: &mut Response) {
    let Some(ct) = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return;
    };
    let essence = ct.to_ascii_lowercase();
    let textual = essence.starts_with("text/")
        || essence.starts_with("application/javascript")
        || essence.starts_with("application/json");
    if textual && !essence.contains("charset") {
        let v = HeaderValue::from_str(&format!("{ct}; charset=utf-8")).expect("ascii mime");
        res.headers_mut().insert(CONTENT_TYPE, v);
    }
}

pub(crate) fn weak_etag(len: u64, mtime_secs: u64) -> String {
    format!("W/\"{len:x}-{mtime_secs:x}\"")
}

pub(crate) fn matches_etag(header: &str, etag: &str) -> bool {
    let weak = |t: &str| t.trim().trim_start_matches("W/").to_owned();
    header.trim() == "*" || header.split(',').any(|t| weak(t) == weak(etag))
}

/// Every miss gets the 4.x `Cannot <METHOD> <originalUrl>` 404; ServeDir's 405 on other methods included.
async fn cannot_404(req: Request, next: Next) -> Response {
    let miss = cannot(&req);
    let res = next.run(req).await;
    if matches!(
        res.status(),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
    ) {
        return miss;
    }
    res
}

/// The 4.x `Cannot <METHOD> <originalUrl>` 404 for the request.
pub fn cannot(req: &Request) -> Response {
    let url = req.uri().path_and_query().map_or("/", |p| p.as_str());
    AppError::not_found(format!("Cannot {} {url}", req.method())).into_response()
}

/// `/cast` always; the SPA at `/` (with `index.html` fallback) only when a client dir is set.
pub fn router(client_dir: Option<PathBuf>, cast_dir: PathBuf) -> Router {
    let cast = ServeDir::new(cast_dir).append_index_html_on_directories(false);
    let mut r = Router::new().nest_service("/cast", cast);
    if let Some(dir) = client_dir {
        r = r
            .fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    r.layer(from_fn(validators)).layer(from_fn(cannot_404))
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
        send(r, Request::get(uri), hdr).await
    }

    async fn send(
        r: &Router,
        mut b: axum::http::request::Builder,
        hdr: Option<(&str, &str)>,
    ) -> Response {
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
    async fn serves_files_spa_cast_and_cannot_404() {
        let (c, k) = dirs("serve");
        let r = router(Some(c), k);
        let file = get(&r, "/app.js", None).await;
        assert_eq!(file.status(), 200);
        assert_eq!(file.headers()[CACHE_CONTROL], "public, max-age=0");
        assert!(file.headers().contains_key(LAST_MODIFIED));
        assert!(file.headers()[ETAG].to_str().unwrap().starts_with("W/\""));
        assert_eq!(
            file.headers()[CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
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
        let post = send(&r, Request::post("/app.js?a=1"), None).await;
        assert_eq!(post.status(), 404);
        assert!(text(post).await.contains("Cannot POST /app.js?a=1"));
    }

    #[tokio::test]
    async fn without_client_dir_only_cast() {
        let (_, k) = dirs("nocli");
        let r = router(None, k);
        assert_eq!(get(&r, "/cast/receiver.html", None).await.status(), 200);
        let miss = get(&r, "/", None).await;
        assert_eq!(miss.status(), 404);
        assert!(text(miss).await.contains("Cannot GET /"));
    }

    #[tokio::test]
    async fn conditional_get_304() {
        let (c, k) = dirs("etag");
        let r = router(Some(c), k);
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
