//! Raw PCM renditions of audio files, made once by the engine's `Pcm` job and kept in the cache.
use crate::{http::AppError, paths, state::AppState};
use axum::{
    body::Body,
    http::{HeaderValue, Request, header},
    response::Response,
};
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, MediaRef};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Opus decodes at 48 kHz: no resampling, and the full quality of a stereo source.
pub const RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const MIME: &str = "audio/L16; rate=48000; channels=2";
const BUDGET_BYTES: u64 = 2 << 30;

pub fn dir() -> PathBuf {
    paths::cache_dir().join("pcm")
}

/// The rendition of `source`, named after its path, version and format so a replaced file gets a new one.
pub async fn rendition(
    st: &AppState,
    media_file_id: i32,
    source: &Path,
) -> Result<PathBuf, AppError> {
    let meta = tokio::fs::metadata(source)
        .await
        .map_err(|_| AppError::not_found("not_found"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let key = Sha256::digest(format!(
        "{}\n{}-{mtime}\n{RATE}x{CHANNELS}",
        source.display(),
        meta.len()
    ));
    let out = dir().join(format!("{}.s16le", hex(&key[..12])));
    if out.is_file() {
        return Ok(out);
    }
    tokio::fs::create_dir_all(dir())
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    let req = JobRequest {
        kind: JobKind::Pcm {
            output: out.to_string_lossy().into_owned(),
            rate: Some(RATE),
            channels: Some(CHANNELS),
        },
        media: MediaRef {
            media_file_id: media_file_id as u32,
            path: source.to_string_lossy().into_owned(),
        },
        priority: Some(JobPriority::High),
        force: false,
    };
    // A concurrent request for the same rendition may have published it first.
    if let Err(e) = st.engine.run_job(&req, None).await
        && !out.is_file()
    {
        return Err(AppError::internal(e.to_string()));
    }
    prune(&dir(), BUDGET_BYTES).await;
    Ok(out)
}

/// The rendition from `from` seconds to its end; any origin may read it, the token in the URL being the credential.
pub async fn serve(path: &Path, from: f64) -> Result<Response, AppError> {
    let len = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .len();
    let frame = 2 * u64::from(CHANNELS);
    let offset = ((from.max(0.0) * f64::from(RATE)) as u64 * frame).min(len.saturating_sub(frame));
    let mut req = Request::builder();
    if offset > 0 {
        req = req.header(header::RANGE, format!("bytes={offset}-"));
    }
    let req = req
        .body(Body::empty())
        .map_err(|e| AppError::internal(e.to_string()))?;
    let mime = MIME.parse().expect("mime");
    let mut res = ServeFile::new_with_mime(path, &mime)
        .oneshot(req)
        .await
        .map_or_else(|e| match e {}, |r| r.map(Body::new));
    let headers = res.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-range"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=0"),
    );
    Ok(res)
}

/// Removes the oldest files of `dir` until the rest fit in `budget` bytes.
async fn prune(dir: &Path, budget: u64) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let mut files = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        if let Ok(m) = e.metadata().await
            && m.is_file()
        {
            files.push((m.modified().ok(), m.len(), e.path()));
        }
    }
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (_, len, path) in files {
        if total <= budget {
            break;
        }
        if tokio::fs::remove_file(&path).await.is_ok() {
            total -= len;
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fliks-pcm-{}", crate::config::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn prune_drops_the_oldest_until_the_rest_fit() {
        let dir = scratch();
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; 10]).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH
                + std::time::Duration::from_secs(1_000 + i as u64);
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(t)
                .unwrap();
        }
        prune(&dir, 20).await;
        assert!(!dir.join("a").exists());
        assert!(dir.join("b").exists() && dir.join("c").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn serve_starts_at_the_frame_of_from_and_lets_any_origin_read() {
        let dir = scratch();
        let p = dir.join("x.s16le");
        std::fs::write(&p, (0..384_000u32).map(|i| i as u8).collect::<Vec<_>>()).unwrap();
        let res = serve(&p, 1.0).await.unwrap();
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(
            res.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .eq_ignore_ascii_case(MIME)
        );
        assert_eq!(
            res.headers()[header::CONTENT_RANGE],
            "bytes 192000-383999/384000"
        );
        let whole = serve(&p, 0.0).await.unwrap();
        assert_eq!(whole.status(), axum::http::StatusCode::OK);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
