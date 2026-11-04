//! `GET /api/comics/:itemId/pages` and `/pages/:index` (`docs/spec/comics.md`, pages rules).
use super::archive::{self, Error};
use crate::{
    http::{AppError, auth::StreamAuthed, validate::PathParams},
    libraries::{HIDDEN_FILES_FROM, accessible_library_ids},
    state::AppState,
    stream::resolve_file,
};
use axum::{
    Json, Router,
    extract::Query,
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG, IF_NONE_MATCH,
            X_CONTENT_TYPE_OPTIONS,
        },
    },
    response::{IntoResponse, Response},
    routing::get,
};
use fliks_domain::acl::{Action, Subject};
use image::{DynamicImage, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder};
use serde::Deserialize;
use serde_json::json;
use std::{io::Cursor, path::PathBuf, sync::LazyLock};
use tokio::sync::Semaphore;

/// Pages decoded at once: a decode holds up to `MAX_ALLOC` bytes.
const PAGE_JOBS: usize = 3;
const MAX_PIXELS: u64 = 25_000_000;
const MAX_ALLOC: u64 = MAX_PIXELS * 8;
const MAX_WIDTH: u32 = 4096;
const JPEG_QUALITY: u8 = 82;
const IMAGE_CSP: &str = "default-src 'none'; sandbox";
const CORP: HeaderName = HeaderName::from_static("cross-origin-resource-policy");

static JOBS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(PAGE_JOBS));

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/comics/{itemId}/pages", get(pages))
        .route("/api/comics/{itemId}/pages/{index}", get(page))
}

fn item_missing(item: i32) -> AppError {
    AppError::not_found(format!("Item #{item} not found"))
}

fn unprocessable(msg: &str) -> AppError {
    AppError::plain(StatusCode::UNPROCESSABLE_ENTITY, msg)
}

fn failure(e: Error, item: i32) -> AppError {
    match e {
        Error::Missing => item_missing(item),
        Error::TooLarge => AppError::payload_too_large("Archive too large"),
        Error::Unsupported(_) => unprocessable("Archive is not readable"),
        Error::Corrupt => unprocessable("Archive cannot be read"),
        Error::NoPages => unprocessable("Issue has no pages"),
    }
}

struct Source {
    path: PathBuf,
    /// Changes with the file's bytes: the file row, its size and mtime.
    tag: String,
}

/// One lookup applies the ACL, so a hidden issue costs what a missing one does and reads like it.
async fn source(st: &AppState, a: &StreamAuthed, item: i32) -> Result<Source, AppError> {
    let acl = accessible_library_ids(&st.db, &a.0).await?;
    let row: Option<(i32, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT mf.id, mf."relativePath" FROM items i
           JOIN comic_issues ci ON ci."itemId" = i.id
           JOIN media m ON m.id = i."mediaId" AND m."libraryId" = ANY($2)
           JOIN editions e ON e.id = i."editionId" AND e.family = 'image'
           JOIN item_parts ip ON ip."itemId" = i.id
           JOIN media_files mf ON mf.id = ip."mediaFileId"
           WHERE i.id = $1 AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}$2) AND hp."mediaFileId" = mf.id)
           ORDER BY ip.version DESC, ip.position, mf.id LIMIT 1"#
    )))
    .bind(item)
    .bind(&acl)
    .fetch_optional(&st.db)
    .await?;
    let (file, rel) = row.ok_or_else(|| item_missing(item))?;
    if rel.to_ascii_lowercase().ends_with(".pdf") {
        return Err(AppError::not_found(format!("Issue #{item} is a PDF")));
    }
    let f = resolve_file(st, None, i64::from(file)).await.map_err(|e| {
        if e.status() == StatusCode::NOT_FOUND {
            item_missing(item)
        } else {
            e
        }
    })?;
    let mtime = tokio::fs::metadata(&f.absolute)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    Ok(Source {
        path: f.absolute,
        tag: format!("{file}-{}-{mtime}", f.size),
    })
}

fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"))
}

/// The 304 answer when the caller already holds `etag`.
fn cached(headers: &HeaderMap, etag: &str, cache: &'static str) -> Option<Response> {
    not_modified(headers, etag).then(|| {
        (
            StatusCode::NOT_MODIFIED,
            [(ETAG, etag.to_owned()), (CACHE_CONTROL, cache.to_owned())],
        )
            .into_response()
    })
}

#[utoipa::path(get, path = "/api/comics/{itemId}/pages", responses((status = 200)))]
pub async fn pages(
    axum::extract::State(st): axum::extract::State<AppState>,
    a: StreamAuthed,
    headers: HeaderMap,
    p: Result<PathParams<i32>, AppError>,
) -> Result<Response, AppError> {
    a.0.require(Action::Read, Subject::Media)?;
    let PathParams(item) = p?;
    let src = source(&st, &a, item).await?;
    let etag = format!("\"p-{}\"", src.tag);
    if let Some(r) = cached(&headers, &etag, "private, no-cache") {
        return Ok(r);
    }
    let list = run(
        move || archive::pages(&src.path).map_err(Failed::from),
        item,
    )
    .await?;
    let body = json!({"pages": list.iter().map(|p| json!({"width": p.width, "height": p.height})).collect::<Vec<_>>()});
    Ok((
        [
            (ETAG, etag),
            (CACHE_CONTROL, "private, no-cache".to_owned()),
        ],
        Json(body),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct PageQuery {
    width: Option<u32>,
}

#[utoipa::path(get, path = "/api/comics/{itemId}/pages/{index}", responses((status = 200)))]
pub async fn page(
    axum::extract::State(st): axum::extract::State<AppState>,
    a: StreamAuthed,
    headers: HeaderMap,
    p: Result<PathParams<(i32, i64)>, AppError>,
    Query(q): Query<PageQuery>,
) -> Result<Response, AppError> {
    a.0.require(Action::Read, Subject::Media)?;
    let PathParams((item, index)) = p?;
    if q.width.is_some_and(|w| w == 0 || w > MAX_WIDTH) {
        return Err(AppError::bad_request(format!(
            "width must be 1 to {MAX_WIDTH}"
        )));
    }
    let index = usize::try_from(index).map_err(|_| AppError::not_found("Page not found"))?;
    let src = source(&st, &a, item).await?;
    let etag = format!("\"{}-{index}-{}\"", src.tag, q.width.unwrap_or(0));
    const CACHE: &str = "private, max-age=31536000, immutable";
    if let Some(r) = cached(&headers, &etag, CACHE) {
        return Ok(r);
    }
    let width = q.width;
    let (content_type, body) = run(
        move || {
            let bytes = archive::page(&src.path, index).map_err(|e| match e {
                Error::Missing => Failed::App(AppError::not_found("Page not found")),
                e => Failed::Archive(e),
            })?;
            render(&bytes, width).map_err(|m| Failed::App(unprocessable(m)))
        },
        item,
    )
    .await?;
    Ok((
        [
            (CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                ETAG,
                HeaderValue::from_str(&etag).map_err(|e| AppError::internal(e.to_string()))?,
            ),
            (CACHE_CONTROL, HeaderValue::from_static(CACHE)),
            (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
            (CONTENT_SECURITY_POLICY, HeaderValue::from_static(IMAGE_CSP)),
            (CORP, HeaderValue::from_static("cross-origin")),
        ],
        body,
    )
        .into_response())
}

/// `work` on the blocking pool, at most `PAGE_JOBS` at a time.
async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Failed> + Send + 'static,
    item: i32,
) -> Result<T, AppError> {
    let _slot = JOBS
        .acquire()
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(|f| f.into_error(item))
}

pub enum Failed {
    Archive(Error),
    App(AppError),
}

impl From<Error> for Failed {
    fn from(e: Error) -> Self {
        Self::Archive(e)
    }
}

impl From<AppError> for Failed {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl Failed {
    fn into_error(self, item: i32) -> AppError {
        match self {
            Self::Archive(e) => failure(e, item),
            Self::App(e) => e,
        }
    }
}

fn reader(bytes: &[u8]) -> Option<ImageReader<Cursor<&[u8]>>> {
    let (w, h) = archive::dimensions(bytes);
    if w == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return None;
    }
    let mut r = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_ALLOC);
    limits.max_image_width = Some(w);
    limits.max_image_height = Some(h);
    r.limits(limits);
    Some(r)
}

fn jpeg(img: &DynamicImage) -> Result<Vec<u8>, &'static str> {
    let rgb = img.to_rgb8();
    let mut out = vec![];
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|_| "Page cannot be encoded")?;
    Ok(out)
}

/// The page as served: the original bytes of a jpeg, png, webp or gif when `width` is absent
/// (the sniffed type, never the entry's name), else a JPEG at `width` at most.
fn render(bytes: &[u8], width: Option<u32>) -> Result<(&'static str, Vec<u8>), &'static str> {
    let bad = "Page is not a readable image";
    let r = reader(bytes).ok_or(bad)?;
    let kind = match r.format() {
        Some(ImageFormat::Jpeg) => Some("image/jpeg"),
        Some(ImageFormat::Png) => Some("image/png"),
        Some(ImageFormat::WebP) => Some("image/webp"),
        Some(ImageFormat::Gif) => Some("image/gif"),
        _ => None,
    };
    let Some(width) = width else {
        return match kind {
            Some(k) => Ok((k, bytes.to_vec())),
            None => jpeg(&r.decode().map_err(|_| bad)?).map(|b| ("image/jpeg", b)),
        };
    };
    let img = r.decode().map_err(|_| bad)?;
    let img = if img.width() > width {
        let h = (u64::from(img.height()) * u64::from(width) + u64::from(img.width()) / 2)
            / u64::from(img.width());
        img.resize_exact(
            width,
            h.max(1) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    jpeg(&img).map(|b| ("image/jpeg", b))
}

/// A JPEG cover of at most `width` from a page's bytes.
pub(crate) fn cover(bytes: &[u8], width: u32) -> Option<Vec<u8>> {
    render(bytes, Some(width)).ok().map(|r| r.1)
}
