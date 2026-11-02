//! Contained filesystem writes under a library root (`ingest.md` rules 1-15, W1-W16).
use crate::engine::resolve::lexical_resolve;
use fliks_domain::naming::validate_folder_name;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

/// `Lc`: the canonical library root; every write target is checked against it.
#[derive(Debug, Clone)]
pub struct Root(PathBuf);

impl Root {
    /// The root must exist and be a directory: nothing ever creates it here.
    pub fn open(library_path: &str) -> io::Result<Root> {
        let c = dunce::canonicalize(library_path)?;
        if !c.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "not a directory",
            ));
        }
        Ok(Root(c))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// `within(Lc, p)`: the realpath of `p`'s deepest existing ancestor, plus the missing tail, is under
    /// the root (equal to it only with `allow_root`).
    pub fn contains(&self, p: &Path, allow_root: bool) -> bool {
        let Some(full) = resolve_existing(p) else {
            return false;
        };
        full.starts_with(&self.0) && (allow_root || full != self.0)
    }

    /// `M`: the root for a root-level movie, else `Lc/<folderName>` once the name is one component.
    pub fn media_dir(&self, folder_name: Option<&str>) -> Result<PathBuf, String> {
        match folder_name.filter(|f| !f.is_empty()) {
            None => Ok(self.0.clone()),
            Some(f) => validate_folder_name(f)
                .map(|f| self.0.join(f))
                .map_err(|_| format!("Invalid folder name \"{f}\"")),
        }
    }
}

/// A stored `relativePath` under a folder root, lexically; `None` when it escapes the root.
pub fn locate(folder: &str, rel: &str) -> Option<PathBuf> {
    let root = lexical_resolve(Path::new(folder), "");
    let abs = lexical_resolve(&root, rel);
    abs.starts_with(&root).then_some(abs)
}

fn fold(p: PathBuf) -> PathBuf {
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    } else {
        p
    }
}

/// Whether two paths name one directory: same realpath (case-folded on Windows and macOS) or same inode.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    if let (Some(x), Some(y)) = (resolve_existing(a), resolve_existing(b))
        && fold(x) == fold(y)
    {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (fs::metadata(a), fs::metadata(b)) {
            return (x.dev(), x.ino()) == (y.dev(), y.ino());
        }
    }
    false
}

/// Whether two paths name one directory or one lies inside the other.
pub fn dirs_overlap(a: &Path, b: &Path) -> bool {
    if same_dir(a, b) {
        return true;
    }
    let (Some(x), Some(y)) = (resolve_existing(a), resolve_existing(b)) else {
        return false;
    };
    let (x, y) = (fold(x), fold(y));
    x.starts_with(&y) || y.starts_with(&x)
}

/// Realpath of the deepest existing ancestor joined with the rest; `None` for a relative path or a
/// tail with `.`/`..`.
fn resolve_existing(p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    let mut cur = p;
    loop {
        if let Ok(real) = dunce::canonicalize(cur) {
            let rest = p.strip_prefix(cur).ok()?;
            if rest
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            {
                return None;
            }
            return Some(real.join(rest));
        }
        cur = cur.parent()?;
    }
}

/// A stored `relativePath` as path components: `\` read as `/`, never absolute, `..` or NUL.
pub fn safe_rel(rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s => out.push(s),
        }
    }
    let normal = out.components().all(|c| matches!(c, Component::Normal(_)));
    (normal && !out.as_os_str().is_empty()).then_some(out)
}

/// `relativePathUnderMediaRoot` on components: `None` when `abs` is not strictly below `dir`.
pub fn rel_under(dir: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(dir).ok()?;
    let parts: Vec<_> = rest
        .components()
        .map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Option<_>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// A source file: resolved through symlinks and required to be a regular file.
pub fn regular_source(p: &Path) -> io::Result<(PathBuf, fs::Metadata)> {
    let real = dunce::canonicalize(p)?;
    let meta = fs::metadata(&real)?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    Ok((real, meta))
}

/// `.fliks-tmp-<uuid v4>`: fixed length, invisible to the scanners.
pub fn tmp_name() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        ".fliks-tmp-{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// `rename` that fails with `AlreadyExists` instead of replacing `to`.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let cstr = |p: &Path| {
            CString::new(p.as_os_str().as_bytes())
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
        };
        let (a, b) = (cstr(from)?, cstr(to)?);
        // SAFETY: both pointers are NUL-terminated strings that outlive the call.
        let r = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                a.as_ptr(),
                libc::AT_FDCWD,
                b.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if r == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if !matches!(e.raw_os_error(), Some(libc::EINVAL | libc::ENOSYS)) {
            return Err(e);
        }
    }
    // Filesystems without renameat2: a hard link never replaces either.
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

/// `rename` retried on the transient errors of a destination held open (Windows antivirus, indexers).
fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut last = None;
    for _ in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if busy(&e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.expect("one attempt"))
}

fn busy(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::ResourceBusy
        || (cfg!(windows) && e.kind() == io::ErrorKind::PermissionDenied)
}

/// Copies `src` next to `dest` under a temp name and `fsync`s it (W2 first half).
fn copy_to_tmp(src: &Path, dest: &Path) -> io::Result<PathBuf> {
    let dir = dest.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let tmp = dir.join(tmp_name());
    let r =
        fs::copy(src, &tmp).and_then(|_| fs::OpenOptions::new().write(true).open(&tmp)?.sync_all());
    match r {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// W2 with a no-replace final rename: `Ok(false)` when `dest` already exists (bytes untouched).
pub fn copy_noreplace(src: &Path, dest: &Path) -> io::Result<bool> {
    let tmp = copy_to_tmp(src, dest)?;
    let r = rename_noreplace(&tmp, dest);
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    reap_later(dest);
    match r {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// W2 for an asked-for overwrite: the existing file's mode is kept, readers see old or new bytes.
pub fn copy_replace(src: &Path, dest: &Path) -> io::Result<()> {
    let tmp = copy_to_tmp(src, dest)?;
    let r = (|| {
        if let Ok(m) = fs::metadata(dest) {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        rename_retry(&tmp, dest)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    reap_later(dest);
    r
}

/// Atomic write of `bytes` to `dest` (W15): temp in the same directory, mode of an existing target kept.
pub fn write_atomic(dest: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = dest.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let tmp = dir.join(tmp_name());
    let r = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        io::Write::write_all(&mut f, bytes)?;
        f.sync_all()?;
        if let Ok(m) = fs::symlink_metadata(dest)
            && m.is_file()
        {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        rename_retry(&tmp, dest)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// A new file: temp in the same directory, `fsync`, no-replace rename; `Ok(false)` when `dest` exists.
pub fn write_new(dest: &Path, bytes: &[u8]) -> io::Result<bool> {
    let dir = dest.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let tmp = dir.join(tmp_name());
    let r = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        io::Write::write_all(&mut f, bytes)?;
        f.sync_all()?;
        rename_noreplace(&tmp, dest)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    match r {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// W4: `rename`, a copy + unlink across filesystems; `Ok(false)` when a no-replace move found `dest`.
pub fn move_file(src: &Path, dest: &Path, replace: bool) -> io::Result<bool> {
    let r = if replace {
        rename_retry(src, dest)
    } else {
        rename_noreplace(src, dest)
    };
    match r {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            let done = if replace {
                copy_replace(src, dest).map(|()| true)?
            } else {
                copy_noreplace(src, dest)?
            };
            if done && let Err(e) = fs::remove_file(src) {
                tracing::warn!("moved by copy, source kept: {}: {e}", src.display());
            }
            Ok(done)
        }
        Err(e) => Err(e),
    }
}

/// W3: temps older than 24 h in `dest`'s directory, detached, regular files only.
fn reap_later(dest: &Path) {
    let Some(dir) = dest.parent().map(Path::to_path_buf) else {
        return;
    };
    std::thread::spawn(move || reap(&dir, Duration::from_secs(24 * 3600)));
}

pub fn reap(dir: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().starts_with(".fliks-tmp-") {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else {
            continue;
        };
        let old = m
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > older_than);
        if m.is_file() && old {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Unlinked {
    Removed,
    Missing,
}

/// The contained unlink: the parent's realpath under the root (the root
/// itself for a root-level movie), never a directory; a symlink is removed, not its target.
pub fn unlink_contained(root: &Root, path: &Path) -> io::Result<Unlinked> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    if !root.contains(parent, true) || path.file_name().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "outside the library root",
        ));
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Unlinked::Missing),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => Err(io::Error::new(
            io::ErrorKind::IsADirectory,
            "is a directory",
        )),
        Ok(_) => match fs::remove_file(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Unlinked::Missing),
            r => r.map(|()| Unlinked::Removed),
        },
    }
}

/// `p` and `q` are equal or one contains the other.
fn overlaps(p: &Path, q: &Path) -> bool {
    p.starts_with(q) || q.starts_with(p)
}

/// Why a media folder is kept on a media delete (`media-write.md` rule 70).
pub fn removable_media_dir(
    root: &Root,
    folder_name: &str,
    library_roots: &[PathBuf],
    other_media_dirs: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    if folder_name.is_empty() {
        return Ok(None);
    }
    let dir = root.media_dir(Some(folder_name))?;
    let meta = match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(m) => m,
    };
    // A link or a file at `D` is unlinked itself; its target is never looked at.
    if !meta.is_dir() {
        return Ok(Some(dir));
    }
    let real = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !real.starts_with(root.path()) || real == root.path() {
        return Err("folder outside the library root".into());
    }
    let hit = |list: &[PathBuf]| {
        list.iter()
            .filter_map(|p| dunce::canonicalize(p).ok().or_else(|| Some(p.clone())))
            .any(|p| overlaps(&real, &p))
    };
    // Roots at or above our own root contain every media folder of it by construction.
    let others: Vec<PathBuf> = library_roots
        .iter()
        .filter_map(|p| dunce::canonicalize(p).ok())
        .filter(|p| !root.path().starts_with(p))
        .collect();
    if hit(&others) {
        return Err("folder overlaps a library root".into());
    }
    if hit(other_media_dirs) {
        return Err("folder is shared with another media".into());
    }
    Ok(Some(dir))
}

/// Removes what [`removable_media_dir`] returned: a link or file is unlinked, a directory removed
/// with its contents (links inside are unlinked, never followed); already gone is success.
pub fn remove_media_dir(dir: &Path) -> io::Result<()> {
    let r = match fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(dir),
        Ok(_) => fs::remove_file(dir),
        Err(e) => Err(e),
    };
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_paths_are_components() {
        assert_eq!(safe_rel("a\\b.mkv"), Some(PathBuf::from("a/b.mkv")));
        for bad in ["", "/etc/hosts", "../x", "a/../../b", "a\0b", ".", "./"] {
            assert_eq!(safe_rel(bad), None, "{bad:?}");
        }
        assert_eq!(
            rel_under(Path::new("/m"), Path::new("/m/a/..foo.mkv")),
            Some("a/..foo.mkv".into())
        );
        assert_eq!(rel_under(Path::new("/m"), Path::new("/m")), None);
        assert_eq!(rel_under(Path::new("/m"), Path::new("/n/a")), None);
    }

    #[test]
    fn locate_stays_under_the_folder() {
        assert_eq!(
            locate("/m/a/", "x/../y/z.mkv"),
            Some(PathBuf::from("/m/a/y/z.mkv"))
        );
        for bad in ["../b.mkv", "/etc/hosts", "x/../../b"] {
            assert_eq!(locate("/m/a", bad), None, "{bad}");
        }
    }

    #[test]
    fn same_dir_follows_links_and_missing_tails() {
        let d = std::env::temp_dir().join(format!("fliks-samedir-{}", std::process::id()));
        let real = d.join("real");
        fs::create_dir_all(&real).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, d.join("link")).unwrap();
            assert!(same_dir(&real, &d.join("link")));
            assert!(same_dir(&real.join("new"), &d.join("link/new")));
        }
        assert!(!same_dir(&real, &d.join("other")));
        assert!(dirs_overlap(&d, &real.join("deeper")) && dirs_overlap(&real.join("deeper"), &d));
        assert!(!dirs_overlap(&real, &d.join("real2")));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn tmp_name_has_fixed_length() {
        let n = tmp_name();
        assert_eq!(n.len(), ".fliks-tmp-".len() + 36);
        assert_eq!(&n[11 + 14..11 + 15], "4");
    }
}
