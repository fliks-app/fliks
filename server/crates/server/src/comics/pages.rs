//! `GET /api/comics/:itemId/pages` and `/pages/:index` (`docs/spec/comics.md`, pages rules).
use super::{
    archive::{self, Error},
    cache::{self, Key},
};
use crate::{
    http::{AppError, auth::FileBoundAuthed, validate::PathParams},
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
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};
use tokio::sync::Semaphore;

/// Pages decoded at once. One decode holds at most `MAX_ALLOC` (200 MB) plus the JPEG and the
/// page bytes (64 MiB), so the peak is about 3 x 270 MB.
const PAGE_JOBS: usize = 3;
const MAX_PIXELS: u64 = 25_000_000;
const MAX_ALLOC: u64 = MAX_PIXELS * 8;
const MAX_WIDTH: u32 = 4096;
const JPEG_QUALITY: u8 = 82;
/// Revalidated on every use: a page is cheap to confirm and the ACL can change.
const NO_CACHE: &str = "private, no-cache";
const IMAGE_CSP: &str = "default-src 'none'; sandbox";
const CORP: HeaderName = HeaderName::from_static("cross-origin-resource-policy");

static JOBS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(PAGE_JOBS)));

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
    key: Key,
}

impl Source {
    /// Changes with the file's bytes: the file row, its size and mtime.
    fn tag(&self) -> String {
        format!("{}-{}-{}", self.key.file, self.key.size, self.key.mtime)
    }
}

/// One lookup applies the ACL, so a hidden issue costs what a missing one does and reads like it.
async fn source(st: &AppState, a: &FileBoundAuthed, item: i32) -> Result<Source, AppError> {
    let acl = accessible_library_ids(&st.db, &a.auth).await?;
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
    // A token bound to a file reads the pages of that file only.
    if a.bound_file
        .is_some_and(|b| i64::from(b) != i64::from(file))
    {
        return Err(item_missing(item));
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
        key: Key {
            file,
            size: f.size,
            mtime,
        },
    })
}

fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"))
}

/// The 304 answer when the caller already holds `etag`.
fn cached(headers: &HeaderMap, etag: &str) -> Option<Response> {
    not_modified(headers, etag).then(|| {
        (
            StatusCode::NOT_MODIFIED,
            [
                (ETAG, etag.to_owned()),
                (CACHE_CONTROL, NO_CACHE.to_owned()),
            ],
        )
            .into_response()
    })
}

#[utoipa::path(get, path = "/api/comics/{itemId}/pages", responses((status = 200)))]
pub async fn pages(
    axum::extract::State(st): axum::extract::State<AppState>,
    a: FileBoundAuthed,
    headers: HeaderMap,
    p: Result<PathParams<i32>, AppError>,
) -> Result<Response, AppError> {
    a.auth.require(Action::Read, Subject::Media)?;
    let PathParams(item) = p?;
    let src = source(&st, &a, item).await?;
    let etag = format!("\"p-{}\"", src.tag());
    if let Some(r) = cached(&headers, &etag) {
        return Ok(r);
    }
    let key = src.key;
    let list = match cache::list(key) {
        Some(l) => l,
        None => {
            let listing = run(move || archive::list(&src.path).map_err(Failed::from), item).await?;
            let list = Arc::new(listing.pages);
            cache::put_list(key, list.clone());
            if let Some(s) = listing.solid {
                cache::put_solid(key, Arc::new(s));
            }
            list
        }
    };
    let body = json!({"pages": list.iter().map(|p| json!({"width": p.width, "height": p.height})).collect::<Vec<_>>()});
    Ok((
        [(ETAG, etag), (CACHE_CONTROL, NO_CACHE.to_owned())],
        Json(body),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct PageQuery {
    width: Option<u32>,
}

/// A solid archive is decoded once and kept (`cache.rs`); the others read the one entry.
fn read_page(path: &Path, key: Key, index: usize) -> Result<Vec<u8>, Failed> {
    let missing = || Failed::App(AppError::not_found("Page not found"));
    if let Some(s) = cache::solid(key) {
        return s.get(index).cloned().ok_or_else(missing);
    }
    if archive::is_solid(path)? {
        let listing = archive::list(path)?;
        cache::put_list(key, Arc::new(listing.pages));
        if let Some(s) = listing.solid {
            let s = Arc::new(s);
            cache::put_solid(key, s.clone());
            return s.get(index).cloned().ok_or_else(missing);
        }
    }
    archive::page(path, index).map_err(|e| match e {
        Error::Missing => missing(),
        e => Failed::Archive(e),
    })
}

#[utoipa::path(get, path = "/api/comics/{itemId}/pages/{index}", responses((status = 200)))]
pub async fn page(
    axum::extract::State(st): axum::extract::State<AppState>,
    a: FileBoundAuthed,
    headers: HeaderMap,
    p: Result<PathParams<(i32, i64)>, AppError>,
    Query(q): Query<PageQuery>,
) -> Result<Response, AppError> {
    a.auth.require(Action::Read, Subject::Media)?;
    let PathParams((item, index)) = p?;
    if q.width.is_some_and(|w| w == 0 || w > MAX_WIDTH) {
        return Err(AppError::bad_request(format!(
            "width must be 1 to {MAX_WIDTH}"
        )));
    }
    // Widths snap up to the next 256 px step, so the client's steps share one answer.
    let width = q.width.map(|w| w.div_ceil(256) * 256);
    let index = usize::try_from(index).map_err(|_| AppError::not_found("Page not found"))?;
    let src = source(&st, &a, item).await?;
    let etag = format!("\"{}-{index}-{}\"", src.tag(), width.unwrap_or(0));
    if let Some(r) = cached(&headers, &etag) {
        return Ok(r);
    }
    let key = src.key;
    let (content_type, body) = run(
        move || {
            let bytes = read_page(&src.path, key, index)?;
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
            (CACHE_CONTROL, HeaderValue::from_static(NO_CACHE)),
            (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
            (CONTENT_SECURITY_POLICY, HeaderValue::from_static(IMAGE_CSP)),
            (CORP, HeaderValue::from_static("cross-origin")),
        ],
        body,
    )
        .into_response())
}

/// `work` on the blocking pool, holding one of the `PAGE_JOBS` slots until it returns.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let slot = JOBS.clone().acquire_owned().await.ok()?;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        work()
    })
    .await
    .ok()
}

async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Failed> + Send + 'static,
    item: i32,
) -> Result<T, AppError> {
    blocking(work)
        .await
        .ok_or_else(|| AppError::internal("page job failed"))?
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
        img.thumbnail_exact(width, h.max(1) as u32)
    } else {
        img
    };
    jpeg(&img).map(|b| ("image/jpeg", b))
}

/// A JPEG cover of at most `width` from a page's bytes.
pub(crate) fn cover(bytes: &[u8], width: u32) -> Option<Vec<u8>> {
    render(bytes, Some(width)).ok().map(|r| r.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![];
        image::RgbImage::new(w, h)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn a_page_is_downscaled_to_the_width_never_upscaled() {
        let (ct, body) = render(&png(600, 900), Some(256)).unwrap();
        let img = image::load_from_memory(&body).unwrap();
        assert_eq!((ct, img.width(), img.height()), ("image/jpeg", 256, 384));
        let (_, body) = render(&png(100, 50), Some(256)).unwrap();
        assert_eq!(image::load_from_memory(&body).unwrap().width(), 100);
    }

    #[test]
    fn a_page_that_is_no_image_is_refused() {
        assert!(render(b"<html></html>", None).is_err());
        assert!(render(&png(8, 8)[..20], None).is_err());
    }
}
