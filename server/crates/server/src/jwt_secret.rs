//! Creates `<conf>/.jwt-secret` exactly where and how Nest's `getJwtSecret` would, so Nest finds it.
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

/// No-op when `JWT_SECRET` is set or the file exists. A write failure only warns: Nest then keeps an in-memory secret.
pub fn ensure(cfg: &Config) {
    if cfg.jwt_secret.is_some() {
        return;
    }
    let dir = conf_dir(cfg);
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let result = private_dir(&dir).and_then(|()| {
        open.open(dir.join(".jwt-secret"))
            .and_then(|mut f| f.write_all(random_hex(32).as_bytes()))
    });
    match result {
        Err(e) if e.kind() != ErrorKind::AlreadyExists => {
            tracing::warn!("cannot persist the JWT secret in {}: {e}", dir.display());
        }
        _ => {}
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
        ensure(&cfg_in(&conf, None));
        let file = conf.join(".jwt-secret");
        let secret = fs::read_to_string(&file).unwrap();
        assert!(secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&conf).unwrap().permissions().mode() & 0o777,
            0o700
        );
        ensure(&cfg_in(&conf, None));
        assert_eq!(fs::read_to_string(&file).unwrap(), secret);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn env_secret_writes_nothing() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        ensure(&cfg_in(&base.join("conf"), Some("x")));
        assert!(!base.exists());
    }
}
