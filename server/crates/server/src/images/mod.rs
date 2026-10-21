//! `GET /api/images/*` (`docs/spec/images.md`): public artwork read from the shared data directory.
use crate::{
    http::{
        AppError,
        static_files::{matches_etag, weak_etag},
    },
    paths::data_dir,
    state::AppState,
};
use axum::{
    Router,
    body::Body,
    extract::{Path, RawQuery, Request},
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, ETAG, IF_NONE_MATCH, LAST_MODIFIED},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub mod paths;
pub mod store;

pub use store::ImageStore;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/images/{kind}/{id}", get(without_variant))
        .route("/api/images/{kind}/{id}/{variant}", get(with_variant))
}

fn not_found() -> AppError {
    AppError::bare(StatusCode::NOT_FOUND)
}

#[utoipa::path(get, path = "/api/images/{kind}/{id}", responses((status = 200)))]
pub async fn without_variant(
    Path((kind, id)): Path<(String, String)>,
    RawQuery(q): RawQuery,
    req: Request,
) -> Result<Response, AppError> {
    serve(&kind, &id, None, q.as_deref(), req).await
}

#[utoipa::path(get, path = "/api/images/{kind}/{id}/{variant}", responses((status = 200)))]
pub async fn with_variant(
    Path((kind, id, variant)): Path<(String, String, String)>,
    RawQuery(q): RawQuery,
    req: Request,
) -> Result<Response, AppError> {
    serve(&kind, &id, Some(&variant), q.as_deref(), req).await
}

/// `thumb` / `medium` only when `size` appears exactly once; anything else is `full`.
fn size_of(query: Option<&str>) -> &'static str {
    let mut sizes = query
        .unwrap_or_default()
        .split('&')
        .filter_map(|kv| kv.strip_prefix("size="));
    match (sizes.next(), sizes.next()) {
        (Some("thumb"), None) => "thumb",
        (Some("medium"), None) => "medium",
        _ => "full",
    }
}

async fn serve(
    kind: &str,
    id: &str,
    variant: Option<&str>,
    query: Option<&str>,
    req: Request,
) -> Result<Response, AppError> {
    let size = size_of(query);
    let mut served = size;
    let mut path = paths::disk_path(data_dir(), kind, id, variant, size)
        .filter(|_| kind != "livetv")
        .ok_or_else(not_found)?;
    if size != "full" && tokio::fs::metadata(&path).await.is_err() {
        served = "full";
        path = paths::disk_path(data_dir(), kind, id, variant, "full").ok_or_else(not_found)?;
    }
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return Err(not_found()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(e) => {
            tracing::error!(error = %e, "image read");
            return Err(AppError::plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error",
            ));
        }
    };
    // Weak ETag from the mtime in seconds.
    let secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let etag = weak_etag(meta.len(), secs);
    let hit = req
        .headers()
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| matches_etag(v, &etag));
    let mut res = if hit {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NOT_MODIFIED;
        if let Ok(t) = meta.modified() {
            r.headers_mut().insert(
                LAST_MODIFIED,
                HeaderValue::from_str(&httpdate::fmt_http_date(t as SystemTime)).expect("ascii"),
            );
        }
        r
    } else {
        let r = ServeFile::new(path).oneshot(req).await.expect("infallible");
        r.map(Body::new).into_response()
    };
    let h = res.headers_mut();
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    if served != size {
        h.insert("x-image-size-served", HeaderValue::from_static("full"));
    }
    if matches!(
        res.status(),
        StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::NOT_MODIFIED
    ) {
        res.headers_mut()
            .insert(ETAG, HeaderValue::from_str(&etag).expect("ascii"));
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_parsing() {
        assert_eq!(size_of(Some("size=thumb")), "thumb");
        assert_eq!(size_of(Some("v=1&size=medium")), "medium");
        assert_eq!(size_of(Some("size=thumb&size=medium")), "full");
        assert_eq!(size_of(Some("size[]=thumb")), "full");
        assert_eq!(size_of(Some("size=huge")), "full");
        assert_eq!(size_of(Some("size=")), "full");
        assert_eq!(size_of(None), "full");
    }
}
