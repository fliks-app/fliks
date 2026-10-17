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

    fn ids(&self) -> Vec<String> {
        std::fs::read_dir(&self.root)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Identical bytes reuse their directory and never count twice against the cap.
    pub fn stage(&self, bytes: &[u8], origin: &str) -> Result<(String, String), StageError> {
        let sha = sha256_hex(bytes);
        let id = sha[..32].to_owned();
        let dir = self.root.join(&id);
        if dir.join("archive.zip").exists() {
            return Ok((id, sha));
        }
        if self.ids().len() >= MAX_STAGED {
            return Err(StageError::Limit);
        }
        let io = |e: std::io::Error| StageError::Io(e.to_string());
        std::fs::create_dir_all(&dir).map_err(io)?;
        set_mode(&self.root, 0o700);
        set_mode(&dir, 0o700);
        for (name, data) in [("archive.zip", bytes), ("origin.txt", origin.as_bytes())] {
            std::fs::write(dir.join(name), data).map_err(io)?;
            set_mode(&dir.join(name), 0o600);
        }
        Ok((id, sha))
    }

    pub fn read(&self, id: &str) -> Option<Vec<u8>> {
        std::fs::read(self.root.join(id).join("archive.zip")).ok()
    }

    /// Recorded by `stage`, never taken from the request.
    pub fn origin(&self, id: &str) -> &'static str {
        match std::fs::read_to_string(self.root.join(id).join("origin.txt")) {
            Ok(s) if s.trim() == "catalog" => "catalog",
            _ => "manual",
        }
    }

    pub fn discard(&self, id: &str) {
        let _ = std::fs::remove_dir_all(self.root.join(id));
    }

    /// The hourly sweep: directories older than one hour.
    pub fn sweep(&self) {
        let cutoff = SystemTime::now() - MAX_AGE;
        for id in self.ids() {
            let dir = self.root.join(&id);
            if std::fs::metadata(&dir)
                .and_then(|m| m.modified())
                .is_ok_and(|t| t < cutoff)
            {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_reuse_and_sweep() {
        let root = std::env::temp_dir().join(format!("fliks-staging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let s = Staging::new(root.clone());
        let (a, _) = s.stage(b"one", "manual").unwrap();
        assert_eq!(s.stage(b"one", "catalog").unwrap().0, a);
        assert_eq!(s.origin(&a), "manual");
        for i in 0..4u8 {
            s.stage(&[i], "catalog").unwrap();
        }
        assert_eq!(s.stage(b"sixth", "manual"), Err(StageError::Limit));
        assert_eq!(s.stage(b"one", "manual").unwrap().0, a);
        s.sweep();
        assert!(s.read(&a).is_some());
        let old = SystemTime::now() - Duration::from_secs(7200);
        std::fs::File::open(root.join(&a))
            .unwrap()
            .set_modified(old)
            .unwrap();
        s.sweep();
        assert!(s.read(&a).is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
