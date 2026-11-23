//! Resolves the JWT secret in `<conf>/.jwt-secret`; same for the engine token.
use crate::config::{Config, random_hex};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Read as _, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The configured dir, then a private temp dir.
fn conf_dirs(cfg: &Config) -> [PathBuf; 2] {
    [
        cfg.conf_dir.clone().unwrap_or_else(|| "/app/conf".into()),
        std::env::temp_dir().join("fliks-conf"),
    ]
}

#[cfg(unix)]
pub(crate) fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
pub(crate) fn euid() -> u32 {
    0
}

/// Set once a secret lives in the temp dir or only in memory: it dies with the container.
static VOLATILE: AtomicBool = AtomicBool::new(false);

pub fn conf_persistent() -> bool {
    !VOLATILE.load(Ordering::Relaxed)
}

/// Files that move from the temp dir to the configured one. `.engine-token` stays: the engine owns it.
const COPY_FORWARD: [&str; 2] = [".jwt-secret", ".push-identity.json"];

enum Read {
    Absent,
    Refused,
    Found(String),
}

/// The configured dir: owned by us, or not world-writable (a root:0 `g=u` volume, a `fsGroup` mount).
/// The temp dir: owned by us only, it is created 0700.
#[cfg(unix)]
fn dir_usable(dir: &Path, temp: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = fs::metadata(dir) else {
        return false;
    };
    let (owner, world_writable) = (m.uid(), m.mode() & 0o002 != 0);
    if owner == euid() {
        if world_writable && !temp {
            tracing::warn!("{} is world-writable: run chmod o-w on it", dir.display());
        }
        return true;
    }
    if !temp && !world_writable {
        return true;
    }
    tracing::error!(
        "{}: owned by uid {owner}, the server runs as uid {} and the directory is {}: run chown -R {} on it",
        dir.display(),
        euid(),
        if temp {
            "not private"
        } else {
            "world-writable"
        },
        euid()
    );
    false
}

#[cfg(not(unix))]
fn dir_usable(_: &Path, _: bool) -> bool {
    true
}

/// A permission error names the path and the `chown` that fixes it; anything else is logged as is.
fn denied(path: &Path, e: &std::io::Error) {
    if e.kind() == ErrorKind::PermissionDenied {
        let dir = path.parent().unwrap_or(path);
        tracing::error!(
            "cannot access {}: {e}: run chown -R {}:0 {} on the host",
            path.display(),
            euid(),
            dir.display()
        );
    } else {
        tracing::error!("cannot open {}: {e}", path.display());
    }
}

/// Opened without following a symlink and checked on the descriptor: a regular file with no other
/// link, owned by us. A group or other bit is dropped and the file adopted.
#[cfg(unix)]
fn read_secret(file: &Path) -> Read {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let f = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(file)
    {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Read::Absent,
        Err(e) => {
            denied(file, &e);
            return Read::Refused;
        }
    };
    let Ok(m) = f.metadata() else {
        return Read::Refused;
    };
    if !m.is_file() || m.nlink() != 1 || m.uid() != euid() {
        tracing::error!(
            "{}: not a regular file with one link owned by uid {}, found uid {}: run chown {} on it, or delete it to rotate",
            file.display(),
            euid(),
            m.uid(),
            euid()
        );
        return Read::Refused;
    }
    if m.mode() & 0o077 != 0 {
        let exposed = file
            .parent()
            .and_then(|d| fs::metadata(d).ok())
            .is_some_and(|d| d.mode() & 0o001 != 0);
        match f.set_permissions(fs::Permissions::from_mode(0o600)) {
            Ok(()) if exposed => tracing::warn!(
                "{} was readable by other users, now 0600: delete it to rotate the secret",
                file.display()
            ),
            Ok(()) => tracing::warn!("{} was open to group or others, now 0600", file.display()),
            Err(e) => {
                tracing::error!("cannot tighten {}: {e}", file.display());
                return Read::Refused;
            }
        }
    }
    read_from(f, file)
}

#[cfg(not(unix))]
fn read_secret(file: &Path) -> Read {
    match fs::File::open(file) {
        Ok(f) => read_from(f, file),
        Err(e) if e.kind() == ErrorKind::NotFound => Read::Absent,
        Err(_) => Read::Refused,
    }
}

fn read_from(mut f: fs::File, file: &Path) -> Read {
    let mut s = String::new();
    if let Err(e) = f.read_to_string(&mut s) {
        tracing::error!("cannot read {}: {e}", file.display());
        return Read::Refused;
    }
    let s = s.trim();
    if s.is_empty() {
        tracing::error!(
            "{} is empty: delete it to generate a new one",
            file.display()
        );
        return Read::Refused;
    }
    Read::Found(s.to_owned())
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

/// Written 0600 through a synced temp file hard-linked into place: the first writer wins, no reader sees a
/// partial file. `None` when the dir is unusable or the file is refused (a shared `/tmp` entry is never adopted).
fn persist(dir: &Path, name: &str, fresh: &str, temp: bool) -> Option<String> {
    let file = dir.join(name);
    if dir.exists() && !dir_usable(dir, temp) {
        return None;
    }
    match read_secret(&file) {
        Read::Found(s) => return Some(s),
        Read::Refused => return None,
        Read::Absent => {}
    }
    let mut b = DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    let written = b.create(dir).and_then(|()| publish(dir, &file, fresh));
    match written {
        Ok(()) => Some(fresh.to_owned()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => match read_secret(&file) {
            Read::Found(s) => Some(s),
            _ => None,
        },
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            denied(&file, &e);
            None
        }
        Err(e) => {
            tracing::warn!("cannot persist {name} in {}: {e}", dir.display());
            None
        }
    }
}

fn publish(dir: &Path, file: &Path, content: &str) -> std::io::Result<()> {
    let tmp = dir.join(format!(".tmp-{}", random_hex(8)));
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let written = open.open(&tmp).and_then(|mut f| {
        f.write_all(content.as_bytes())?;
        f.sync_all()
    });
    let linked = written.and_then(|()| fs::hard_link(&tmp, file));
    let _ = fs::remove_file(&tmp);
    linked
}

fn resolve_file(cfg: &Config, name: &str) -> String {
    resolve_state(cfg, name, random_hex(32)).0
}

/// `<conf>/<name>` (`fresh` is written 0600 when absent) and the path to rewrite it at, `None` when no
/// conf dir is usable (process-local). A copy left in the temp dir moves to the configured dir.
pub fn resolve_state(cfg: &Config, name: &str, fresh: String) -> (String, Option<PathBuf>) {
    let [conf, tmp] = conf_dirs(cfg);
    resolve_in(&conf, &tmp, name, fresh)
}

fn resolve_in(conf: &Path, tmp: &Path, name: &str, fresh: String) -> (String, Option<PathBuf>) {
    let old = (COPY_FORWARD.contains(&name) && conf != tmp && dir_usable(tmp, true))
        .then(|| match read_secret(&tmp.join(name)) {
            Read::Found(s) => Some(s),
            _ => None,
        })
        .flatten();
    let fresh = old.clone().unwrap_or(fresh);
    if let Some(s) = persist(conf, name, &fresh, false) {
        if old.is_some() {
            let _ = fs::remove_file(tmp.join(name));
        }
        return (s, Some(conf.join(name)));
    }
    VOLATILE.store(true, Ordering::Relaxed);
    if let Some(s) = persist(tmp, name, &fresh, true) {
        tracing::warn!(
            "{} is not usable: {name} is kept in {}, lost when the container is recreated \
             (every Subsonic app password and push registration with it)",
            conf.display(),
            tmp.display()
        );
        return (s, Some(tmp.join(name)));
    }
    tracing::warn!("no usable conf dir for {name}: using a process-local value");
    (fresh, None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

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
    fn a_new_file_is_published_whole_and_leaves_no_temp_file() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        let conf = base.join("conf");
        resolve(&cfg_in(&conf, None));
        let names: Vec<_> = fs::read_dir(&conf)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from(".jwt-secret")]);
        let file = conf.join(".jwt-secret");
        let err = publish(&conf, &file, "other").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read_dir(&conf).unwrap().count(), 1);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn env_secret_writes_nothing() {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        assert_eq!(resolve(&cfg_in(&base.join("conf"), Some("x"))), "x");
        assert!(!base.exists());
    }

    fn scratch() -> PathBuf {
        let base = std::env::temp_dir().join(format!("fliks-jwt-{}", random_hex(4)));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn chmod(p: &Path, mode: u32) {
        fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn an_owned_world_writable_dir_keeps_its_secret() {
        let base = scratch();
        chmod(&base, 0o777);
        assert_eq!(
            persist(&base, ".jwt-secret", "fresh", false),
            Some("fresh".into())
        );
        assert_eq!(
            persist(&base, ".jwt-secret", "other", false),
            Some("fresh".into())
        );
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_foreign_dir_is_usable_unless_world_writable() {
        if fs::metadata("/").unwrap().uid() == euid() {
            return;
        }
        assert!(dir_usable(Path::new("/"), false));
        assert!(!dir_usable(Path::new("/"), true));
        let tmp = Path::new("/tmp");
        if fs::metadata(tmp).unwrap().uid() != euid() {
            assert!(!dir_usable(tmp, false));
        }
    }

    #[test]
    fn an_open_secret_file_is_tightened_and_adopted() {
        let base = scratch();
        let file = base.join(".jwt-secret");
        fs::write(&file, "planted\n").unwrap();
        chmod(&file, 0o644);
        assert_eq!(
            persist(&base, ".jwt-secret", "fresh", false),
            Some("planted".into())
        );
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_symlink_or_hard_link_is_refused() {
        let base = scratch();
        let real = base.join("real");
        fs::write(&real, "x").unwrap();
        chmod(&real, 0o600);
        std::os::unix::fs::symlink(&real, base.join(".jwt-secret")).unwrap();
        assert_eq!(persist(&base, ".jwt-secret", "fresh", false), None);
        fs::hard_link(&real, base.join(".push-identity.json")).unwrap();
        assert_eq!(persist(&base, ".push-identity.json", "fresh", false), None);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_temp_copy_moves_forward_then_is_removed() {
        let base = scratch();
        let (conf, tmp) = (base.join("conf"), base.join("tmp"));
        fs::create_dir_all(&tmp).unwrap();
        chmod(&tmp, 0o700);
        for n in [".jwt-secret", ".push-identity.json", ".engine-token"] {
            fs::write(tmp.join(n), "old").unwrap();
            chmod(&tmp.join(n), 0o600);
        }
        let (s, path) = resolve_in(&conf, &tmp, ".jwt-secret", "fresh".into());
        assert_eq!((s.as_str(), path), ("old", Some(conf.join(".jwt-secret"))));
        assert_eq!(fs::read_to_string(conf.join(".jwt-secret")).unwrap(), "old");
        assert!(!tmp.join(".jwt-secret").exists());
        // an existing conf file wins, and the stale temp copy still goes
        fs::write(conf.join(".push-identity.json"), "kept").unwrap();
        chmod(&conf.join(".push-identity.json"), 0o600);
        let (s, _) = resolve_in(&conf, &tmp, ".push-identity.json", "fresh".into());
        assert_eq!(s, "kept");
        assert!(!tmp.join(".push-identity.json").exists());
        // the engine token is never moved
        let (s, _) = resolve_in(&conf, &tmp, ".engine-token", "fresh".into());
        assert_eq!(s, "fresh");
        assert_eq!(
            fs::read_to_string(tmp.join(".engine-token")).unwrap(),
            "old"
        );
        fs::remove_dir_all(&base).unwrap();
    }
}
