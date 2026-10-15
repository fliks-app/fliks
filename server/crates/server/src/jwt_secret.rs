//! Resolves the JWT secret like Nest's `getJwtSecret`, creating `<conf>/.jwt-secret` where Nest looks for it.
use crate::config::{Config, random_hex};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

fn private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

fn writable(dir: &Path) -> bool {
    private_dir(dir).is_ok() && {
        let probe = dir.join(".probe");
        fs::File::create(&probe).is_ok() && fs::remove_file(probe).is_ok()
    }
}

/// Same candidates and probe as `resolveWritableDir`; the last candidate is the best-effort fallback.
fn conf_dir(cfg: &Config) -> PathBuf {
    let candidates = [
        cfg.conf_dir.clone().unwrap_or_else(|| "/app/conf".into()),
        std::env::temp_dir().join("fliks-conf"),
    ];
    match candidates.iter().position(|d| writable(d)) {
        Some(i) => candidates[i].clone(),
        None => candidates[1].clone(),
    }
}

fn read(file: &Path) -> Option<String> {
    let s = fs::read_to_string(file).ok()?.trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// `JWT_SECRET`, else the conf file, else a fresh one written 0600 (`create_new`: the first writer wins).
/// A failed write only warns and yields a process-local secret, which Nest will not share.
pub fn resolve(cfg: &Config) -> String {
    if let Some(s) = &cfg.jwt_secret {
        return s.clone();
    }
    let dir = conf_dir(cfg);
    let file = dir.join(".jwt-secret");
    if let Some(s) = read(&file) {
        return s;
    }
    let secret = random_hex(32);
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let result = private_dir(&dir).and_then(|()| {
        open.open(&file)
            .and_then(|mut f| f.write_all(secret.as_bytes()))
    });
    match result {
        Ok(()) => secret,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => read(&file).unwrap_or_else(|| {
            tracing::warn!(
                "{} is empty: using a process-local JWT secret",
                file.display()
            );
            secret
        }),
        Err(e) => {
            tracing::warn!("cannot persist the JWT secret in {}: {e}", dir.display());
            secret
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn cfg_in(dir: &Path, jwt: Option<&str>) -> Config {
        let mut c = Config::from_lookup(|k| match k {
            "FLIKS_CONF_DIR" => Some(dir.to_string_lossy().into()),
            _ => None,
        });
        c.jwt_secret = jwt.map(Into::into);
        c
    }

    #[test]
    fn creates_hex_0600_in_0700_dir_and_keeps_an_existing_file() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        let conf = base.join("conf");
        let first = resolve(&cfg_in(&conf, None));
        let file = conf.join(".jwt-secret");
        let secret = fs::read_to_string(&file).unwrap();
        assert_eq!(first, secret);
        assert!(secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&conf).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(resolve(&cfg_in(&conf, None)), secret);
        assert_eq!(fs::read_to_string(&file).unwrap(), secret);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn env_secret_writes_nothing() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        assert_eq!(resolve(&cfg_in(&base.join("conf"), Some("x"))), "x");
        assert!(!base.exists());
    }
}
