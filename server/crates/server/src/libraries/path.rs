//! A library's root path: `sanitizeFsPath`, `statfs` and the `assignPath` state machine (rules 6, 13, 37).
use super::db::{Disk, not_found};
use crate::http::AppError;
use sqlx::PgConnection;
use std::{io, path::Path};

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

/// Disk space of `path`, off the async runtime.
pub async fn disk(path: &str) -> Disk {
    let path = path.to_owned();
    match tokio::task::spawn_blocking(move || space(path))
        .await
        .ok()
        .flatten()
    {
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

/// `assignPath` (rule 13): the directory is created last, right before the `UPDATE`.
pub async fn assign(c: &mut PgConnection, id: i32, raw: &str) -> Result<(), AppError> {
    let current = sqlx::query_scalar!("SELECT path FROM libraries WHERE id = $1", id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or_else(|| not_found(id))?;
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
        return save(c, id, None).await;
    }
    if current.as_deref() == Some(&path) {
        return Ok(());
    }
    if !path.starts_with('/') {
        return Err(AppError::bad_request(vec!["path must be an absolute path"]));
    }
    let taken = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM libraries WHERE path = $1 AND id <> $2) AS "taken!""#,
        path,
        id
    )
    .fetch_one(&mut *c)
    .await?;
    if taken {
        return Err(AppError::bad_request(format!(
            "Path \"{path}\" is already attached to another library"
        )));
    }
    if let Some(current) = current {
        let used = media_count(c, id).await?;
        if used > 0 {
            return Err(AppError::bad_request(format!(
                "Path \"{current}\" still contains {used} media item(s) — cannot change the library's root path."
            )));
        }
    }
    if tokio::fs::metadata(&path).await.is_err()
        && let Err(e) = tokio::fs::create_dir_all(Path::new(&path)).await
    {
        return Err(AppError::bad_request(format!(
            "Path \"{path}\" could not be created on the server: {}, mkdir '{path}'",
            io_text(&e)
        )));
    }
    save(c, id, Some(&path)).await
}

async fn media_count(c: &mut PgConnection, id: i32) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM media WHERE "libraryId" = $1"#,
        id
    )
    .fetch_one(c)
    .await
}

async fn save(c: &mut PgConnection, id: i32, path: Option<&str>) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE libraries SET path = $2, "updatedAt" = now() WHERE id = $1"#,
        id,
        path
    )
    .execute(c)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_marks_and_js_whitespace() {
        assert_eq!(sanitize("\u{202A}/data/x"), "/data/x");
        assert_eq!(sanitize("/da\u{200B}ta\u{FEFF}"), "/data");
        assert_eq!(sanitize(" \t\u{A0}\u{3000}/x\n"), "/x");
        assert_eq!(sanitize(" \u{200B} "), "");
        assert_eq!(sanitize("\u{85}/x\u{85}"), "\u{85}/x\u{85}");
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
