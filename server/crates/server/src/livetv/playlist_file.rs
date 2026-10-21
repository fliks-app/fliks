//! Uploaded playlists (`livetv-sources.md` rules 12-16): kept with the data, never in the cache.
use crate::{engine::resolve::lexical_resolve, events::uuid_v4, paths::data_dir};
use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::io::AsyncWriteExt;

pub fn playlist_dir() -> PathBuf {
    data_dir().join("livetv").join("playlists")
}

pub fn is_http_source(location: &str) -> bool {
    let t = fliks_domain::js::trim(location).to_lowercase();
    t.starts_with("http://") || t.starts_with("https://")
}

/// A stored upload, as opposed to a path an administrator typed: under the playlist directory by
/// path components, symlinks followed when the file exists.
pub fn is_managed_upload(location: &str) -> bool {
    managed_in(location, &playlist_dir())
}

fn managed_in(location: &str, dir: &Path) -> bool {
    if is_http_source(location) {
        return false;
    }
    let resolved = lexical_resolve(&std::env::current_dir().unwrap_or_default(), location);
    let real = dunce::canonicalize(&resolved).unwrap_or(resolved);
    let dir = dunce::canonicalize(dir)
        .unwrap_or_else(|_| lexical_resolve(Path::new("/"), &dir.to_string_lossy()));
    real.starts_with(dir)
}

/// `<stem>-<uuid v4>.m3u`: the stem is a hint for a human, the uuid is the identity.
pub fn stored_name(original: &str) -> String {
    let stem = Path::new(original)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem: String = {
        let mut out = String::new();
        let mut gap = false;
        for c in stem.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                out.push(c);
                gap = false;
            } else if !gap {
                out.push('-');
                gap = true;
            }
        }
        out.chars().take(40).collect()
    };
    let stem = if stem.is_empty() {
        "playlist".into()
    } else {
        stem
    };
    format!("{stem}-{}.m3u", uuid_v4())
}

/// A writer into a temp file next to its destination; `finish` renames it, a drop removes it.
pub struct Upload {
    file: Option<tokio::fs::File>,
    temp: PathBuf,
    dest: PathBuf,
    pub written: u64,
    pub head: Vec<u8>,
}

impl Upload {
    pub async fn create(original: &str) -> std::io::Result<Self> {
        let dir = playlist_dir();
        tokio::fs::create_dir_all(&dir).await?;
        let dest = dir.join(stored_name(original));
        let temp = dir.join(format!(".upload-{}.tmp", uuid_v4()));
        Ok(Self {
            file: Some(tokio::fs::File::create(&temp).await?),
            temp,
            dest,
            written: 0,
            head: vec![],
        })
    }

    pub async fn write(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        if self.head.len() < 64 {
            let take = (64 - self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
        }
        self.written += chunk.len() as u64;
        self.file.as_mut().expect("open").write_all(chunk).await
    }

    pub async fn finish(mut self) -> std::io::Result<PathBuf> {
        if let Some(mut f) = self.file.take() {
            f.flush().await?;
        }
        tokio::fs::rename(&self.temp, &self.dest).await?;
        self.temp = PathBuf::new();
        Ok(self.dest.clone())
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        if !self.temp.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

/// The first 64 bytes, decoded and trimmed at the start, must open an extended playlist.
pub fn looks_like_m3u(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    let t = text.trim_start_matches(fliks_domain::js::is_ws);
    t.starts_with("#EXTM3U") || t.starts_with("#EXTINF")
}

pub async fn remove(location: &str) {
    if is_managed_upload(location)
        && let Err(e) = tokio::fs::remove_file(location).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("Failed to remove a stored playlist: {e}");
    }
}

pub struct Local {
    pub body: String,
    /// The mtime in milliseconds, played by an ETag.
    pub version: String,
}

/// Refuses anything outside the playlist directory: a source's `url` is never a free file read.
pub async fn read_local(location: &str) -> Result<Local, String> {
    if !is_managed_upload(location) {
        return Err("Not an uploaded playlist".into());
    }
    let bytes = tokio::fs::read(location).await.map_err(|e| e.to_string())?;
    let mtime = tokio::fs::metadata(location)
        .await
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?;
    let ms = mtime
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    Ok(Local {
        body: String::from_utf8_lossy(&bytes).into_owned(),
        version: format!("{ms}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_names_keep_a_safe_stem() {
        let n = stored_name("My List (2).m3u8");
        assert!(n.starts_with("My-List-2-") && n.ends_with(".m3u"), "{n}");
        assert!(stored_name("").starts_with("playlist-"));
        assert!(stored_name("../../etc/passwd").starts_with("passwd-"));
        let long = stored_name(&format!("{}.m3u", "a".repeat(80)));
        assert_eq!(long.len(), 40 + 1 + 36 + 4);
        let id = uuid_v4();
        assert_eq!(
            (id.len(), id.as_bytes()[14], id.as_bytes()[8]),
            (36, b'4', b'-')
        );
    }

    #[test]
    fn a_sibling_directory_sharing_the_prefix_is_not_managed() {
        let t = std::env::temp_dir().join(format!("fliks-pl-{}", uuid_v4()));
        let dir = t.join("playlists");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(t.join("playlists-x")).unwrap();
        let inside = dir.join("a.m3u");
        let sibling = t.join("playlists-x").join("a.m3u");
        let outside = t.join("a.m3u");
        for p in [&inside, &sibling, &outside] {
            std::fs::write(p, "#EXTM3U").unwrap();
        }
        assert!(managed_in(&inside.to_string_lossy(), &dir));
        assert!(!managed_in(&sibling.to_string_lossy(), &dir));
        assert!(!managed_in(&outside.to_string_lossy(), &dir));
        assert!(!managed_in(&format!("{}/../a.m3u", dir.display()), &dir));
        assert!(!managed_in("http://h/playlists/a.m3u", &dir));
        std::os::unix::fs::symlink(&outside, dir.join("link.m3u")).unwrap();
        assert!(!managed_in(&dir.join("link.m3u").to_string_lossy(), &dir));
        std::fs::remove_dir_all(t).unwrap();
    }

    #[test]
    fn the_head_must_open_a_playlist() {
        for ok in ["#EXTM3U\n", "  \u{feff}#EXTINF:-1,x", "\n\n#EXTM3U"] {
            assert!(looks_like_m3u(ok.as_bytes()), "{ok:?}");
        }
        for bad in ["", "<html>", "x#EXTM3U"] {
            assert!(!looks_like_m3u(bad.as_bytes()), "{bad:?}");
        }
    }
}
