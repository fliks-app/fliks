//! KEPUB downloads (`kobo.md` rules 27-30): an EPUB converted on its first download, then cached.
use super::{BOOK_PREFIX, Kobo, books, uuid};
use crate::{http::AppError, state::AppState};
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// The converted files kept on disk; the least recently served go first.
const CACHE_MAX_BYTES: u64 = 1 << 30;
const STALE_TMP: Duration = Duration::from_secs(3600);

/// One conversion at a time: each holds a whole document in memory. The guard moves into the
/// blocking job, so it outlives a download that is dropped mid-conversion.
fn gate() -> Arc<tokio::sync::Mutex<()>> {
    static G: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    G.get_or_init(Default::default).clone()
}

pub fn cache_root(st: &AppState) -> PathBuf {
    st.kepub_cache
        .as_deref()
        .map_or_else(|| crate::paths::cache_dir().join("kepub"), PathBuf::from)
}

fn touch(path: PathBuf) {
    // Best effort: a failure only makes eviction less exact.
    let _ = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|f| f.set_modified(SystemTime::now()));
}

/// The KEPUB of the EPUB at `src` (file row `file`), converted at most once per version of the file.
pub async fn ensure(dir: &FsPath, file: i32, src: &FsPath) -> Option<PathBuf> {
    let meta = tokio::fs::metadata(src).await.ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let key = format!("{file}-{}-{mtime}", meta.len());
    let target = dir.join(format!("{key}.kepub.epub"));
    let hit = |t: PathBuf| async move {
        let c = t.clone();
        let _ = tokio::task::spawn_blocking(move || touch(c)).await;
        t
    };
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Some(hit(target).await);
    }
    let guard = gate().lock_owned().await;
    // A download that waited here finds the first one's file.
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Some(hit(target).await);
    }
    let (s, t, d, k) = (src.to_path_buf(), target.clone(), dir.to_path_buf(), key);
    let done = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        convert_file(&s, &t, &d)?;
        prune(&d, file, &k);
        Ok::<_, String>(())
    })
    .await;
    match done {
        Ok(Ok(())) => Some(target),
        other => {
            let why = other.map_or_else(|e| e.to_string(), |r| r.err().unwrap_or_default());
            tracing::warn!(file, error = %why, "kepub conversion failed, serving the EPUB");
            None
        }
    }
}

fn convert_file(src: &FsPath, target: &FsPath, dir: &FsPath) -> Result<(), String> {
    use std::io::{BufReader, BufWriter, Write};
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(crate::ingest::fsx::tmp_name());
    let run = || -> Result<(), String> {
        let input = BufReader::new(std::fs::File::open(src).map_err(|e| e.to_string())?);
        let mut out = BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
        kepub::convert(input, &mut out, &kepub::Limits::default()).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, target).map_err(|e| e.to_string())
    };
    run().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Drops the older versions of `file`, stale temporaries, then the least recently served files
/// above the size cap. Runs under the gate, so it never races a conversion.
fn prune(dir: &FsPath, file: i32, keep_key: &str) {
    crate::ingest::fsx::reap(dir, STALE_TMP);
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let (own, keep) = (format!("{file}-"), format!("{keep_key}."));
    let mut files = vec![];
    let mut total = 0;
    for e in read.flatten() {
        let (Ok(m), Some(name)) = (e.metadata(), e.file_name().to_str().map(str::to_owned)) else {
            continue;
        };
        if !name.ends_with(".kepub.epub") {
            continue;
        }
        if name.starts_with(&keep) {
            total += m.len();
        } else if name.starts_with(&own) {
            let _ = std::fs::remove_file(e.path());
        } else {
            total += m.len();
            files.push((
                m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                m.len(),
                e.path(),
            ));
        }
    }
    files.sort();
    for (_, len, path) in files {
        if total <= CACHE_MAX_BYTES {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total -= len;
        }
    }
}

/// The file's absolute path, still under its folder root after symlinks.
async fn source(st: &AppState, file: i32) -> Result<Option<PathBuf>, sqlx::Error> {
    let row: Option<(String, String)> = sqlx::query_as(
        r#"SELECT lf.path, mf."relativePath" FROM media_files mf
           JOIN library_folders lf ON lf.id = mf."folderId" WHERE mf.id = $1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await?;
    let Some((folder, rel)) = row else {
        return Ok(None);
    };
    Ok(match crate::ingest::fsx::locate(&folder, &rel) {
        Some(abs) => crate::ingest::fsx::contained(&folder, abs).await,
        None => None,
    })
}

pub async fn kepub(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
    req: Request,
) -> Result<Response, AppError> {
    let Some(b) = books::find(&st.db, &k, &id).await? else {
        return Ok(books::not_found());
    };
    let Some(src) = source(&st, b.file).await? else {
        return Ok(books::not_found());
    };
    let plain = format!(
        "{}/cred/{}/api/stream/{}?download=1",
        k.base, k.token, b.file
    );
    let (method, headers) = (req.method().clone(), req.headers().clone());
    let dir = cache_root(&st);
    // A hit can be evicted between `ensure` and the open: the second pass converts again.
    for _ in 0..2 {
        let Some(path) = ensure(&dir, b.file, &src).await else {
            return Ok(Redirect::temporary(&plain).into_response());
        };
        let mime = "application/epub+zip".parse().expect("mime");
        let mut again = Request::new(Body::empty());
        *again.method_mut() = method.clone();
        *again.headers_mut() = headers.clone();
        let Ok(served) = ServeFile::new_with_mime(path, &mime).oneshot(again).await;
        if served.status() == StatusCode::NOT_FOUND {
            continue;
        }
        return Ok(finish(served.map(Body::new), b.item));
    }
    Ok(books::not_found())
}

fn finish(mut res: Response, item: i32) -> Response {
    let name = format!("{}.kepub.epub", uuid(BOOK_PREFIX, item));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    res
}
