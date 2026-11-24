//! A library's folder path: `sanitizeFsPath`, `statfs` and the `assignPath` state machine (rules 6, 13, 37, 42-46).
use super::db::{Disk, not_found};
use crate::http::AppError;
use sqlx::PgConnection;
use std::{io, path::Path, time::Duration};

/// Strips bidi marks and zero-width characters, then trims like JS `trim()` (Rust also trims U+0085).
pub fn sanitize(raw: &str) -> String {
    let drop = |c: char| matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}');
    let clean: String = raw.chars().filter(|c| !drop(*c)).collect();
    clean
        .trim_matches(|c: char| c.is_whitespace() && c != '\u{85}')
        .to_owned()
}

/// `(free, total)` bytes: `f_bfree * f_bsize` (root-reserved blocks count as free) and `f_blocks * f_bsize`.
#[cfg(unix)]
fn space(path: String) -> Option<(i64, i64)> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: `s` is fully written by a successful `statvfs`, which is checked before it is read.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| {
        let size = s.f_bsize as i64;
        (s.f_bfree as i64 * size, s.f_blocks as i64 * size)
    })
}

/// `(free, total)` bytes, free ignoring per-user quotas like the unix `f_bfree`.
#[cfg(windows)]
fn space(path: String) -> Option<(i64, i64)> {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain([0])
        .collect();
    let (mut total, mut free) = (0u64, 0u64);
    // SAFETY: `w` is NUL-terminated; the out-pointers are valid and the null one is optional.
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            w.as_ptr(),
            std::ptr::null_mut(),
            &mut total,
            &mut free,
        )
    };
    (ok != 0).then_some((free as i64, total as i64))
}

/// What the health checks read of a folder; `fs` identifies the filesystem where the platform can.
pub struct Probe {
    pub avail: i64,
    pub writable: bool,
    pub empty: bool,
    pub fs: Option<u64>,
}

/// `None` when the path is not a readable directory (an unmounted share, a removed folder).
#[cfg(unix)]
fn probe_blocking(path: String) -> Option<Probe> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_dir())?;
    let empty = std::fs::read_dir(&path).ok()?.next().is_none();
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: `s` is fully written by a successful `statvfs`, which is checked before it is read.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    // SAFETY: `c` is a valid NUL-terminated path.
    let writable = unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0;
    Some(Probe {
        avail: s.f_bavail as i64 * s.f_frsize as i64,
        writable,
        empty,
        fs: Some(meta.dev()),
    })
}

#[cfg(windows)]
fn probe_blocking(path: String) -> Option<Probe> {
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_dir())?;
    let empty = std::fs::read_dir(&path).ok()?.next().is_none();
    Some(Probe {
        avail: space(path)?.0,
        writable: !meta.permissions().readonly(),
        empty,
        fs: None,
    })
}

/// A dead hard-mounted share blocks the syscalls in uninterruptible sleep: past this it counts as unreachable.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs `f` off the runtime; `None` when it fails or outlasts `limit` (the stuck thread is left to finish).
async fn bounded<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    tokio::time::timeout(limit, tokio::task::spawn_blocking(f))
        .await
        .ok()?
        .ok()
        .flatten()
}

/// Free space for the user (`f_bavail`), writability and emptiness of `path`, off the async runtime.
/// `None` when the path is unreadable or does not answer within [`PROBE_TIMEOUT`].
pub async fn probe(path: &str) -> Option<Probe> {
    let path = path.to_owned();
    bounded(PROBE_TIMEOUT, move || probe_blocking(path)).await
}

/// Disk space of `path`, off the async runtime; unavailable when it does not answer within [`PROBE_TIMEOUT`].
pub async fn disk(path: &str) -> Disk {
    let path = path.to_owned();
    disk_within(PROBE_TIMEOUT, move || space(path)).await
}

async fn disk_within(
    limit: Duration,
    f: impl FnOnce() -> Option<(i64, i64)> + Send + 'static,
) -> Disk {
    match bounded(limit, f).await {
        Some((free_space, total_space)) => Disk {
            free_space,
            total_space,
            accessible: true,
        },
        None => Disk {
            free_space: -1,
            total_space: -1,
            accessible: false,
        },
    }
}

fn io_text(e: &io::Error) -> String {
    let s = e.to_string().to_lowercase();
    s.split(" (os error").next().unwrap_or(&s).to_owned()
}

/// The input without `.`, `..`, doubled or trailing separators, never touching the disk.
pub fn normalize(path: &str) -> String {
    fliks_domain::media::path::fold(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

/// Boot check: warns for every pair of folders of different libraries that name one directory
/// (case, symlink or bind-mount variants) and for every folder this process cannot write (imports,
/// hardlinks and deletes fail there); nothing is changed. The filesystem work runs on a
/// blocking thread so a hung mount stalls only this check.
pub async fn warn_overlapping_folders(db: &sqlx::PgPool) -> sqlx::Result<()> {
    let folders =
        sqlx::query!(r#"SELECT "libraryId" AS library_id, path FROM library_folders ORDER BY id"#)
            .fetch_all(db)
            .await?;
    let _ = tokio::task::spawn_blocking(move || {
        for f in &folders {
            warn_unwritable(Path::new(&f.path));
        }
        for (i, a) in folders.iter().enumerate() {
            for b in &folders[i + 1..] {
                if a.library_id != b.library_id
                    && crate::ingest::fsx::same_dir(Path::new(&a.path), Path::new(&b.path))
                {
                    tracing::warn!(
                        "library #{} \"{}\" and library #{} \"{}\" are one directory: media there is listed twice",
                        a.library_id,
                        a.path,
                        b.library_id,
                        b.path
                    );
                }
            }
        }
    })
    .await;
    Ok(())
}

#[cfg(unix)]
fn warn_unwritable(dir: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return;
    };
    // SAFETY: access reads a NUL-terminated path.
    let denied = unsafe { libc::access(c.as_ptr(), libc::W_OK | libc::X_OK) } != 0;
    if denied && dir.is_dir() {
        tracing::warn!(
            "library folder {} is not writable by uid {}: run the container as the owner of the media \
             (`user: \"<uid>:0\"` in the compose file, group 0 keeps the data volumes writable) or chown it",
            dir.display(),
            crate::jwt_secret::euid()
        );
    }
}

#[cfg(not(unix))]
fn warn_unwritable(_: &Path) {}

/// `assignPath` (rule 13): the directory is created last, right before the write.
pub async fn assign(c: &mut PgConnection, id: i32, raw: &str) -> Result<(), AppError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM libraries WHERE id = $1) AS "e!""#,
        id
    )
    .fetch_one(&mut *c)
    .await?;
    if !exists {
        return Err(not_found(id));
    }
    super::folders::lock(c).await?;
    let several = sqlx::query_scalar!(
        r#"SELECT count(*) > 1 AS "several!" FROM library_folders WHERE "libraryId" = $1"#,
        id
    )
    .fetch_one(&mut *c)
    .await?;
    if several {
        return Err(AppError::bad_request(format!(
            "Path cannot be set on a library with several folders: use /libraries/{id}/folders"
        )));
    }
    let current = sqlx::query_scalar!(
        r#"SELECT path AS "path!" FROM library_default_folders WHERE "libraryId" = $1"#,
        id
    )
    .fetch_optional(&mut *c)
    .await?;
    let path = sanitize(raw);
    if path.is_empty() {
        let Some(current) = current else {
            return Ok(());
        };
        let used = media_count(c, id).await?;
        if used > 0 {
            return Err(AppError::bad_request(format!(
                "Path \"{current}\" still contains {used} media item(s)."
            )));
        }
        sqlx::query!(r#"DELETE FROM library_folders WHERE "libraryId" = $1"#, id)
            .execute(&mut *c)
            .await?;
        return touch(c, id).await;
    }
    if !Path::new(&path).is_absolute() {
        return Err(AppError::bad_request(vec!["path must be an absolute path"]));
    }
    let path = normalize(&path);
    if current.as_deref().map(normalize).as_deref() == Some(&path) {
        return Ok(());
    }
    if super::folders::reserved(&path) {
        return Err(AppError::bad_request(format!(
            "Path \"{path}\" is reserved"
        )));
    }
    if super::folders::overlapping(c, &path, None, Some(id))
        .await?
        .is_some()
    {
        return Err(taken(&path));
    }
    if let Some(current) = current {
        let used = media_count(c, id).await?;
        if used > 0 {
            return Err(AppError::bad_request(format!(
                "Path \"{current}\" still contains {used} media item(s) \u{2014} cannot change the library's root path."
            )));
        }
    }
    ensure_dir(&path).await?;
    save(c, id, &path).await
}

/// `mkdir -p` of a missing folder, the last step before the write (rule 13.5).
pub async fn ensure_dir(path: &str) -> Result<(), AppError> {
    if tokio::fs::metadata(path).await.is_err()
        && let Err(e) = tokio::fs::create_dir_all(Path::new(path)).await
    {
        return Err(AppError::bad_request(format!(
            "Path \"{path}\" could not be created on the server: {}, mkdir '{path}'",
            io_text(&e)
        )));
    }
    Ok(())
}

fn taken(path: &str) -> AppError {
    AppError::bad_request(format!(
        "Path \"{path}\" is already attached to another library"
    ))
}

async fn media_count(c: &mut PgConnection, id: i32) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM media WHERE "libraryId" = $1"#,
        id
    )
    .fetch_one(c)
    .await
}

async fn touch(c: &mut PgConnection, id: i32) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE libraries SET "updatedAt" = now() WHERE id = $1"#,
        id
    )
    .execute(c)
    .await?;
    Ok(())
}

async fn save(c: &mut PgConnection, id: i32, path: &str) -> Result<(), AppError> {
    let lost = |e: sqlx::Error| {
        if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
            taken(path)
        } else {
            e.into()
        }
    };
    let updated = sqlx::query!(
        r#"UPDATE library_folders SET path = $2 WHERE "libraryId" = $1"#,
        id,
        path
    )
    .execute(&mut *c)
    .await
    .map_err(lost)?;
    if updated.rows_affected() == 0 {
        sqlx::query!(
            r#"INSERT INTO library_folders ("libraryId", path) VALUES ($1, $2)"#,
            id,
            path
        )
        .execute(&mut *c)
        .await
        .map_err(lost)?;
    }
    touch(c, id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_probe_that_never_returns_gives_up_after_the_limit() {
        let (hold, wait) = std::sync::mpsc::channel::<()>();
        let r = bounded(Duration::from_millis(50), move || {
            let _ = wait.recv();
            Some(1)
        })
        .await;
        assert_eq!(r, None);
        drop(hold);
        assert_eq!(bounded(Duration::from_secs(5), || Some(2)).await, Some(2));
    }

    #[tokio::test]
    async fn a_disk_call_that_never_returns_reports_unavailable() {
        let (hold, wait) = std::sync::mpsc::channel::<()>();
        let d = disk_within(Duration::from_millis(50), move || {
            let _ = wait.recv();
            Some((1, 2))
        })
        .await;
        assert_eq!((d.free_space, d.total_space, d.accessible), (-1, -1, false));
        drop(hold);
    }

    #[test]
    fn sanitize_strips_marks_and_js_whitespace() {
        assert_eq!(sanitize("\u{202A}/data/x"), "/data/x");
        assert_eq!(sanitize("/da\u{200B}ta\u{FEFF}"), "/data");
        assert_eq!(sanitize(" \t\u{A0}\u{3000}/x\n"), "/x");
        assert_eq!(sanitize(" \u{200B} "), "");
        assert_eq!(sanitize("\u{85}/x\u{85}"), "\u{85}/x\u{85}");
    }

    #[test]
    fn normalize_folds_dots_and_separators() {
        assert_eq!(normalize("/a//b/./c/../d/"), "/a/b/d");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("/"), "/");
    }

    #[tokio::test]
    async fn disk_arithmetic_and_failure() {
        let d = disk("/tmp").await;
        assert!(d.accessible && d.total_space >= d.free_space && d.free_space >= 0);
        let bad = disk("/nonexistent/fliks").await;
        assert_eq!(
            (bad.free_space, bad.total_space, bad.accessible),
            (-1, -1, false)
        );
    }
}
