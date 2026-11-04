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
    collections::{HashMap, HashSet},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// The converted files kept on disk; the oldest go first.
const CACHE_MAX_BYTES: u64 = 1 << 30;
const STALE_TMP: Duration = Duration::from_secs(3600);
/// Conversions that run at once: each holds a whole document in memory.
const SLOTS: usize = 2;
const FAILED_MAX: usize = 1024;

type Locks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

fn locks() -> &'static Locks {
    static L: OnceLock<Locks> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Versions that failed to convert, so a book that cannot be converted is not retried per request.
fn failed() -> &'static Mutex<HashSet<String>> {
    static F: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

fn slots() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(SLOTS))
}

pub fn cache_root(st: &AppState) -> PathBuf {
    st.kepub_cache
        .as_deref()
        .map_or_else(|| crate::paths::cache_dir().join("kepub"), PathBuf::from)
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
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Some(target);
    }
    if failed().lock().ok()?.contains(&key) {
        return None;
    }
    let lock = locks().lock().ok()?.entry(key.clone()).or_default().clone();
    let guard = lock.lock().await;
    let out = convert_once(dir, file, src, &key, &target).await;
    drop(guard);
    if let Ok(mut map) = locks().lock()
        && Arc::strong_count(&lock) <= 2
    {
        map.remove(&key);
    }
    out
}

async fn convert_once(
    dir: &FsPath,
    file: i32,
    src: &FsPath,
    key: &str,
    target: &FsPath,
) -> Option<PathBuf> {
    // A request that waited on the lock finds the first one's file.
    if tokio::fs::try_exists(target).await.unwrap_or(false) {
        return Some(target.to_path_buf());
    }
    let _slot = slots().acquire().await.ok()?;
    let (s, t, d) = (src.to_path_buf(), target.to_path_buf(), dir.to_path_buf());
    let res = tokio::task::spawn_blocking(move || convert_file(&s, &t, &d)).await;
    match res {
        Ok(Ok(())) => {
            let (d, k) = (dir.to_path_buf(), key.to_string());
            let _ = tokio::task::spawn_blocking(move || prune(&d, file, &k)).await;
            Some(target.to_path_buf())
        }
        other => {
            let why = match other {
                Ok(Err(e)) => e,
                Err(e) => e.to_string(),
                Ok(Ok(())) => unreachable!(),
            };
            tracing::warn!(file, error = %why, "kepub conversion failed, serving the EPUB");
            if let Ok(mut f) = failed().lock() {
                if f.len() >= FAILED_MAX {
                    f.clear();
                }
                f.insert(key.to_string());
            }
            None
        }
    }
}

fn convert_file(src: &FsPath, target: &FsPath, dir: &FsPath) -> Result<(), String> {
    use std::io::{BufReader, BufWriter, Write};
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("tmp");
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

/// Drops the older versions of `file`, stale temporaries, then the oldest files above the size cap.
fn prune(dir: &FsPath, file: i32, keep_key: &str) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let (own, keep) = (format!("{file}-"), format!("{keep_key}."));
    let mut files = vec![];
    for e in read.flatten() {
        let (Ok(m), Some(name)) = (e.metadata(), e.file_name().to_str().map(str::to_owned)) else {
            continue;
        };
        let age = m
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .unwrap_or_default();
        let old_version = name.starts_with(&own) && !name.starts_with(&keep);
        if old_version || (name.ends_with(".tmp") && age > STALE_TMP) {
            let _ = std::fs::remove_file(e.path());
        } else if !name.ends_with(".tmp") && !name.starts_with(&keep) {
            files.push((
                m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                m.len(),
                e.path(),
            ));
        }
    }
    let kept = std::fs::metadata(dir.join(format!("{keep_key}.kepub.epub"))).map_or(0, |m| m.len());
    let mut total = kept + files.iter().map(|f| f.1).sum::<u64>();
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
    let found = crate::ingest::fsx::locate(&folder, &rel).and_then(|abs| {
        let real = dunce::canonicalize(abs).ok()?;
        real.starts_with(dunce::canonicalize(&folder).ok()?)
            .then_some(real)
    });
    Ok(found)
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
    let Some(path) = ensure(&cache_root(&st), b.file, &src).await else {
        let plain = format!(
            "{}/cred/{}/api/stream/{}?download=1",
            k.base, k.token, b.file
        );
        return Ok(Redirect::temporary(&plain).into_response());
    };
    let Ok(served) = ServeFile::new_with_mime(path, &"application/epub+zip".parse().expect("mime"))
        .oneshot(req)
        .await;
    let mut res = served.map(Body::new);
    let name = format!("{}.kepub.epub", uuid(BOOK_PREFIX, b.item));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    Ok(match res.status() {
        StatusCode::NOT_FOUND => books::not_found(),
        _ => res,
    })
}
