//! Sidecar names and the lexical path helpers (`subtitle-path.util.ts`, `media-path.util.ts`).
use crate::js::{is_ws, rx};

/// `en`, `en.forced` or `en.hi`; forced wins when both flags are set.
pub fn sidecar_lang_suffix(lang: &str, forced: bool, hearing_impaired: bool) -> String {
    if forced {
        format!("{lang}.forced")
    } else if hearing_impaired {
        format!("{lang}.hi")
    } else {
        lang.to_owned()
    }
}

/// `^[a-z]{2,3}(\.(forced|hi))?$`: the only suffixes a generated name may carry.
pub fn is_safe_lang_suffix(suffix: &str) -> bool {
    rx!(r"^[a-z]{2,3}(\.(forced|hi))?$").is_match(suffix)
}

/// `path.resolve` for an absolute POSIX path: `.` and `..` collapsed, no trailing slash.
fn resolve(p: &str) -> Option<String> {
    if !p.starts_with('/') {
        return None;
    }
    let mut out: Vec<&str> = vec![];
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    Some(format!("/{}", out.join("/")))
}

fn resolve_from(base: &str, p: &str) -> Option<String> {
    if p.starts_with('/') {
        resolve(p)
    } else {
        resolve(&format!("{base}/{p}"))
    }
}

/// A stored location under `root`, lexically (symlinks are the caller's concern); `None` outside it.
pub fn resolve_subtitle_absolute_path(root: &str, stored: &str) -> Option<String> {
    let (stored, root) = (stored.trim_matches(is_ws), root.trim_matches(is_ws));
    if stored.is_empty() || root.is_empty() {
        return None;
    }
    let root = resolve(root)?;
    let abs = resolve_from(&root, stored)?;
    (abs == root || abs.starts_with(&format!("{root}/"))).then_some(abs)
}

/// `file` relative to `root` with `/` separators; `None` when it is the root or outside it.
pub fn relative_path_under_root(root: &str, file: &str) -> Option<String> {
    let root = resolve(root.trim_matches(is_ws))?;
    let abs = resolve(file)?;
    let rel = if root == "/" {
        abs.trim_start_matches('/').to_owned()
    } else {
        abs.strip_prefix(&format!("{root}/"))?.to_owned()
    };
    (!rel.is_empty() && !rel.starts_with("..")).then_some(rel)
}
