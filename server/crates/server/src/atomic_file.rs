//! Temp-file-then-rename writes, so readers never see a partial file (`image-store.md` rule 12).
use std::{io, path::Path, time::Duration};

/// Prefix of the temp files; scanners skip it.
pub const TEMP_PREFIX: &str = ".fliks-tmp-";
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY: Duration = Duration::from_millis(100);

/// `EBUSY`, and the Windows sharing errors (`EPERM`, `EACCES`).
fn busy(e: &io::Error) -> bool {
    match e.raw_os_error() {
        #[cfg(unix)]
        Some(code) => code == libc::EBUSY,
        #[cfg(windows)]
        Some(code) => matches!(code, 5 | 32 | 33),
        _ => false,
    }
}

/// Writes `bytes` next to `dest` and renames over it, keeping the destination's mode when it exists.
pub async fn write_atomic(dest: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = dest
        .parent()
        .ok_or_else(|| io::Error::other("no parent directory"))?;
    let tmp = dir.join(format!("{TEMP_PREFIX}{}", crate::config::random_hex(8)));
    let done = async {
        tokio::fs::write(&tmp, bytes).await?;
        if let Ok(meta) = tokio::fs::metadata(dest).await {
            tokio::fs::set_permissions(&tmp, meta.permissions()).await?;
        }
        for attempt in 1..=RENAME_ATTEMPTS {
            match tokio::fs::rename(&tmp, dest).await {
                Err(e) if busy(&e) && attempt < RENAME_ATTEMPTS => {
                    tokio::time::sleep(RENAME_RETRY).await
                }
                other => return other,
            }
        }
        unreachable!("the last attempt returns")
    }
    .await;
    if done.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_replaces_and_leaves_no_temp_file() {
        let dir =
            std::env::temp_dir().join(format!("fliks-atomic-{}", crate::config::random_hex(4)));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let f = dir.join("a.bin");
        write_atomic(&f, b"one").await.unwrap();
        write_atomic(&f, b"two").await.unwrap();
        assert_eq!(tokio::fs::read(&f).await.unwrap(), b"two");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["a.bin"]);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_failing_rename_cleans_the_temp_file() {
        let dir =
            std::env::temp_dir().join(format!("fliks-atomic-{}", crate::config::random_hex(4)));
        tokio::fs::create_dir_all(dir.join("dest")).await.unwrap();
        assert!(write_atomic(&dir.join("dest"), b"x").await.is_err());
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["dest"]);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
