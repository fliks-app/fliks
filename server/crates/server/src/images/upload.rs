//! Uploaded JPEGs (user avatars, party covers) stored as `<dataDir>/<dir>/<id>.jpg` and served by `GET /api/images/*`.
use super::store;
use crate::{http::AppError, paths::data_dir};
use axum::extract::{DefaultBodyLimit, Multipart, multipart::MultipartRejection};
use image::{ImageFormat, ImageReader};
use std::{io::Cursor, path::PathBuf};

const MAX: usize = 5 * 1024 * 1024;

/// The route layer that admits a `MAX` file plus its multipart framing.
pub fn body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX + 64 * 1024)
}

fn path(dir: &str, id: i32, suffix: &str) -> PathBuf {
    data_dir().join(dir).join(format!("{id}{suffix}"))
}

fn upload_error(e: impl std::fmt::Display) -> AppError {
    tracing::warn!(error = %e, "image upload failed");
    AppError::bad_request("No image uploaded")
}

/// The `file` field of a multipart body: its part content type and its bytes, non-empty and at most `MAX`.
async fn read_file(
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<(Option<String>, Vec<u8>), AppError> {
    let mut multipart = multipart.map_err(upload_error)?;
    let mut file: Option<(Option<String>, Vec<u8>)> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(upload_error)? {
        if field.file_name().is_none() {
            continue;
        }
        let name = field.name().unwrap_or_default().to_owned();
        if name != "file" {
            return Err(AppError::bad_request(format!("Unexpected field - {name}")));
        }
        let mime = field.content_type().map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(upload_error)? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX {
                return Err(AppError::payload_too_large("File too large"));
            }
        }
        file.get_or_insert((mime, bytes));
    }
    file.filter(|(_, b)| !b.is_empty())
        .ok_or_else(|| AppError::bad_request("No image uploaded"))
}

/// A file declared `image/jpeg`, kept as sent.
pub async fn read_jpeg(
    multipart: Result<Multipart, MultipartRejection>,
    what: &str,
) -> Result<Vec<u8>, AppError> {
    let (mime, bytes) = read_file(multipart).await?;
    if mime.as_deref() != Some("image/jpeg") {
        return Err(AppError::bad_request(format!(
            "{what} must be a JPEG image"
        )));
    }
    Ok(bytes)
}

/// A JPEG, PNG or WebP file told apart by its bytes, stored as a JPEG; anything else (SVG included) is refused.
pub async fn read_image(
    multipart: Result<Multipart, MultipartRejection>,
    what: &str,
) -> Result<Vec<u8>, AppError> {
    let (_, bytes) = read_file(multipart).await?;
    let format = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.format());
    let jpeg = match format {
        Some(ImageFormat::Jpeg) => Some(bytes),
        Some(ImageFormat::Png | ImageFormat::WebP) => store::to_jpeg(&bytes),
        _ => None,
    };
    jpeg.ok_or_else(|| AppError::bad_request(format!("{what} must be a JPEG, PNG or WebP image")))
}

pub async fn write(dir: &str, id: i32, bytes: &[u8]) -> Result<(), AppError> {
    let dest = path(dir, id, ".jpg");
    let io = |e: std::io::Error| AppError::internal(e.to_string());
    tokio::fs::create_dir_all(dest.parent().expect("image dir"))
        .await
        .map_err(io)?;
    tokio::fs::write(&dest, bytes).await.map_err(io)
}

/// Every file of the image, whichever variants exist.
pub async fn remove(dir: &str, id: i32) {
    for suffix in [".jpg", "-thumb.jpg", "-medium.jpg", ".src.json"] {
        if let Err(e) = tokio::fs::remove_file(path(dir, id, suffix)).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(dir, id, error = %e, "image file removal failed");
        }
    }
}
