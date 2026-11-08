//! MP3+G: the `.cdg` graphics file next to a track (`docs/spec/karaoke.md` rule 32).
use crate::lyrics::discover::listing;
use std::path::{Path, PathBuf};

/// The `.cdg` of `audio`: same base name (compared without case), a regular file (a link is not followed).
pub async fn sidecar(audio: &Path) -> Option<PathBuf> {
    let dir = audio.parent()?;
    let want = format!(
        "{}.cdg",
        audio.file_stem()?.to_string_lossy().to_lowercase()
    );
    let name = listing(dir)
        .await
        .into_iter()
        .find(|n| n.to_lowercase() == want)?;
    let path = dir.join(name);
    tokio::fs::symlink_metadata(&path)
        .await
        .ok()?
        .is_file()
        .then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finds_the_pair_without_case_and_skips_other_names() {
        let d = std::env::temp_dir().join(format!("cdg-{}", crate::config::random_hex(4)));
        tokio::fs::create_dir_all(&d).await.unwrap();
        for n in ["Song.MP3", "SONG.CDG", "other.cdg"] {
            tokio::fs::write(d.join(n), b"x").await.unwrap();
        }
        assert_eq!(sidecar(&d.join("Song.MP3")).await, Some(d.join("SONG.CDG")));
        assert_eq!(sidecar(&d.join("third.mp3")).await, None);
        let _ = tokio::fs::remove_dir_all(&d).await;
    }
}
