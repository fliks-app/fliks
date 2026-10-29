//! Resolves the JWT secret in `<conf>/.jwt-secret`; same for the engine token.
use crate::config::{Config, random_hex};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// Same candidates as the engine's token store, in the same order, so both agree on the directory.
fn conf_dirs(cfg: &Config) -> [PathBuf; 2] {
    [
        cfg.conf_dir.clone().unwrap_or_else(|| "/app/conf".into()),
        std::env::temp_dir().join("fliks-conf"),
    ]
}

/// Owned by this user; a secret file is also closed to group and others (the engine's rule).
#[cfg(unix)]
fn trusted(path: &Path, private: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).is_ok_and(|m| {
        // SAFETY: geteuid has no preconditions.
        m.uid() == unsafe { libc::geteuid() } && (!private || m.mode() & 0o077 == 0)
    })
}

#[cfg(not(unix))]
fn trusted(_: &Path, _: bool) -> bool {
    true
}

fn read(file: &Path) -> Option<String> {
    if !trusted(file, true) {
        return None;
    }
    let s = fs::read_to_string(file).ok()?.trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// `JWT_SECRET`, else the conf file, else a fresh one written 0600 (`create_new`: the first writer wins).
/// With no usable conf dir the secret is process-local, lost at the next start.
pub fn resolve(cfg: &Config) -> String {
    cfg.jwt_secret
        .clone()
        .unwrap_or_else(|| resolve_file(cfg, ".jwt-secret"))
}

/// The engine control token when `FLIKS_ENGINE_TOKEN` is empty: same file pattern, `.engine-token`.
pub fn resolve_engine_token(cfg: &Config) -> String {
    if cfg.engine_token.is_empty() {
        resolve_file(cfg, ".engine-token")
    } else {
        cfg.engine_token.clone()
    }
}

/// Written 0600 with `create_new`, so the first writer wins; `None` when the dir is not writable
/// or the dir or file is not ours (a shared `/tmp` entry is never adopted).
fn persist(dir: &Path, name: &str, fresh: &str) -> Option<String> {
    let file = dir.join(name);
    if dir.exists() && !trusted(dir, false) {
        return None;
    }
    if let Some(s) = read(&file) {
        return Some(s);
    }
    let mut b = DirBuilder::new();
    b.recursive(true);
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    }
    let written = b.create(dir).and_then(|()| {
        open.open(&file)
            .and_then(|mut f| f.write_all(fresh.as_bytes()))
    });
    match written {
        Ok(()) => Some(fresh.to_owned()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => read(&file),
        Err(e) => {
            tracing::warn!("cannot persist {name} in {}: {e}", dir.display());
            None
        }
    }
}

fn resolve_file(cfg: &Config, name: &str) -> String {
    let fresh = random_hex(32);
    conf_dirs(cfg)
        .iter()
        .find_map(|d| persist(d, name, &fresh))
        .unwrap_or_else(|| {
            tracing::warn!("no usable conf dir for {name}: using a process-local secret");
            fresh
        })
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
    fn engine_token_env_wins_else_file() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        let conf = base.join("conf");
        let mut c = cfg_in(&conf, None);
        c.engine_token = "set".into();
        assert_eq!(resolve_engine_token(&c), "set");
        assert!(!base.exists());
        c.engine_token = String::new();
        let t = resolve_engine_token(&c);
        assert_eq!(t.len(), 64);
        assert_eq!(fs::read_to_string(conf.join(".engine-token")).unwrap(), t);
        assert_eq!(resolve_engine_token(&c), t);
        assert_ne!(resolve(&c), t);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn env_secret_writes_nothing() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        assert_eq!(resolve(&cfg_in(&base.join("conf"), Some("x"))), "x");
        assert!(!base.exists());
    }

    #[test]
    fn a_secret_file_open_to_others_is_not_adopted() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        let conf = base.join("conf");
        fs::create_dir_all(&conf).unwrap();
        let file = conf.join(".jwt-secret");
        fs::write(&file, "planted").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_ne!(
            persist(&conf, ".jwt-secret", "fresh"),
            Some("planted".into())
        );
        assert_eq!(persist(&conf, ".jwt-secret", "fresh"), None);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            persist(&conf, ".jwt-secret", "fresh"),
            Some("planted".into())
        );
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_dir_not_owned_by_this_user_is_skipped() {
        let root = Path::new("/");
        let owner = fs::metadata(root).unwrap();
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        if std::os::unix::fs::MetadataExt::uid(&owner) == me {
            return;
        }
        assert!(!trusted(root, false));
        assert_eq!(persist(root, ".jwt-secret", "fresh"), None);
    }
}
