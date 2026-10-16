//! `Media.path` (rule 30): Node's `path.join` / `path.resolve` on POSIX.

/// `path.normalize`.
pub fn normalize(path: &str) -> String {
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

/// `path.resolve(p)` against `cwd`.
pub fn resolve(p: &str, cwd: &str) -> String {
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
}
