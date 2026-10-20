//! Staged uploads between inspect and confirm (`plugins.md` rule 17).
use super::archive::sha256_hex;
use super::runtime::set_mode;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const MAX_STAGED: usize = 5;
const MAX_AGE: Duration = Duration::from_secs(3600);

pub struct Staging {
    root: PathBuf,
}

#[derive(Debug, PartialEq)]
pub enum StageError {
    Limit,
    Io(String),
}

impl Staging {
    pub fn new(root: PathBuf) -> Self {
        Staging { root }
    }

    async fn ids(&self) -> Vec<String> {
        let Ok(mut rd) = tokio::fs::read_dir(&self.root).await else {
            return vec![];
        };
        let mut ids = vec![];
        while let Ok(Some(e)) = rd.next_entry().await {
            ids.push(e.file_name().to_string_lossy().into_owned());
        }
        ids
    }

    /// Identical bytes reuse their directory and never count twice against the cap.
    pub async fn stage(&self, bytes: &[u8], origin: &str) -> Result<(String, String), StageError> {
        let sha = sha256_hex(bytes);
        let id = sha[..32].to_owned();
        let dir = self.root.join(&id);
        if tokio::fs::try_exists(dir.join("archive.zip"))
            .await
            .unwrap_or(false)
        {
            return Ok((id, sha));
        }
        if self.ids().await.len() >= MAX_STAGED {
            return Err(StageError::Limit);
        }
        let io = |e: std::io::Error| StageError::Io(e.to_string());
        tokio::fs::create_dir_all(&dir).await.map_err(io)?;
        set_mode(&self.root, 0o700);
        set_mode(&dir, 0o700);
        for (name, data) in [("archive.zip", bytes), ("origin.txt", origin.as_bytes())] {
            tokio::fs::write(dir.join(name), data).await.map_err(io)?;
            set_mode(&dir.join(name), 0o600);
        }
        Ok((id, sha))
    }

    pub async fn read(&self, id: &str) -> Option<Vec<u8>> {
        tokio::fs::read(self.root.join(id).join("archive.zip"))
            .await
            .ok()
    }

    /// Recorded by `stage`, never taken from the request.
    pub async fn origin(&self, id: &str) -> &'static str {
        match tokio::fs::read_to_string(self.root.join(id).join("origin.txt")).await {
            Ok(s) if s.trim() == "catalog" => "catalog",
            _ => "manual",
        }
    }

    /// False when no such directory existed.
    pub async fn discard(&self, id: &str) -> bool {
        tokio::fs::remove_dir_all(self.root.join(id)).await.is_ok()
    }

    /// The hourly sweep: directories older than one hour.
    pub async fn sweep(&self) {
        let cutoff = SystemTime::now() - MAX_AGE;
        for id in self.ids().await {
            let dir = self.root.join(&id);
            if tokio::fs::metadata(&dir)
                .await
                .and_then(|m| m.modified())
                .is_ok_and(|t| t < cutoff)
            {
                let _ = tokio::fs::remove_dir_all(dir).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cap_reuse_and_sweep() {
        let root = std::env::temp_dir().join(format!("fliks-staging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let s = Staging::new(root.clone());
        let (a, _) = s.stage(b"one", "manual").await.unwrap();
        assert_eq!(s.stage(b"one", "catalog").await.unwrap().0, a);
        assert_eq!(s.origin(&a).await, "manual");
        for i in 0..4u8 {
            s.stage(&[i], "catalog").await.unwrap();
        }
        assert_eq!(s.stage(b"sixth", "manual").await, Err(StageError::Limit));
        assert_eq!(s.stage(b"one", "manual").await.unwrap().0, a);
        s.sweep().await;
        assert!(s.read(&a).await.is_some());
        assert!(s.discard(&a).await);
        assert!(!s.discard(&a).await);
        assert_eq!(s.stage(b"one", "manual").await.unwrap().0, a);
        let old = SystemTime::now() - Duration::from_secs(7200);
        std::fs::File::open(root.join(&a))
            .unwrap()
            .set_modified(old)
            .unwrap();
        s.sweep().await;
        assert!(s.read(&a).await.is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
