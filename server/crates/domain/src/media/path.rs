//! `Media.path` (rule 30): Node's `path.join` / `path.resolve` on POSIX.
use std::path::{Component, Path, PathBuf};

/// `path.normalize`; a Windows drive or UNC path keeps its own form.
pub fn normalize(path: &str) -> String {
    if let Some(Component::Prefix(_)) = Path::new(path).components().next() {
        return fold(Path::new(path)).to_string_lossy().into_owned();
    }
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out: Vec<&str> = vec![];
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                Some(&l) if l != ".." => {
                    out.pop();
                }
                _ if !absolute => out.push(".."),
                _ => {}
            },
            s => out.push(s),
        }
    }
    let mut p = out.join("/");
    if p.is_empty() {
        return match (absolute, trailing) {
            (true, _) => "/".into(),
            (false, true) => "./".into(),
            _ => ".".into(),
        };
    }
    if trailing {
        p.push('/');
    }
    if absolute { format!("/{p}") } else { p }
}

/// `path.join(a, b)`.
pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => ".".into(),
        (true, false) => normalize(b),
        (false, true) => normalize(a),
        _ => normalize(&format!("{a}/{b}")),
    }
}

/// Lexical `path.resolve` of a rooted host path (`/x`, `C:\x`, UNC): `.` and `..` collapsed.
pub fn lexical(p: &Path) -> Option<PathBuf> {
    p.has_root().then(|| fold(p))
}

/// `p` with `.` dropped and `..` folded, never touching the disk.
pub fn fold(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// `path.resolve(p)` against `cwd`; a Windows drive or UNC path keeps its own form.
pub fn resolve(p: &str, cwd: &str) -> String {
    if let Some(Component::Prefix(_)) = Path::new(p).components().next()
        && let Some(abs) = lexical(Path::new(p))
    {
        return abs.to_string_lossy().into_owned();
    }
    let full = if p.starts_with('/') {
        p.to_owned()
    } else {
        format!("{cwd}/{p}")
    };
    let n = normalize(&full);
    if n.len() > 1 {
        n.trim_end_matches('/').to_owned()
    } else {
        n
    }
}

/// The `path` getter: `None` without a library path, the library path itself without a folder.
pub fn media_path(library_path: Option<&str>, folder_name: Option<&str>) -> Option<String> {
    let lib = library_path.filter(|p| !p.is_empty())?;
    Some(match folder_name.filter(|f| !f.is_empty()) {
        Some(f) => join(lib, f),
        None => lib.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_collapses_and_resolves() {
        assert_eq!(join("/media//movies", "a/../b"), "/media/movies/b");
        assert_eq!(media_path(Some("/m/"), Some("")), Some("/m/".into()));
        assert_eq!(resolve("a/b", "/srv"), "/srv/a/b");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_keeps_a_windows_absolute_path() {
        assert_eq!(resolve(r"C:\Users\m", "/"), r"C:\Users\m");
        assert_eq!(resolve(r"C:\m/a/../b/", "/"), r"C:\m\b");
        assert_eq!(resolve("//nas/share/m", "/"), r"//nas/share\m");
        assert_eq!(
            join(r"//nas/share\m", "Movie/a.mkv"),
            r"//nas/share\m\Movie\a.mkv"
        );
    }
}
