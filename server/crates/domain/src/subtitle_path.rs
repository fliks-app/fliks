//! Sidecar names and the lexical path helpers (`subtitle-path.util.ts`, `media-path.util.ts`).
use crate::js::{is_ws, rx};
use crate::media::path::lexical;
use std::path::Path;

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

/// `^[a-z]{2,3}$`: a stored language code.
pub fn is_language_code(s: &str) -> bool {
    rx!(r"^[a-z]{2,3}$").is_match(s)
}

/// `^[a-z]{2,3}(\.(forced|hi))?$`: the only suffixes a generated name may carry.
pub fn is_safe_lang_suffix(suffix: &str) -> bool {
    rx!(r"^[a-z]{2,3}(\.(forced|hi))?$").is_match(suffix)
}

/// A stored location under `root`, lexically (symlinks are the caller's concern); `None` outside it.
pub fn resolve_subtitle_absolute_path(root: &str, stored: &str) -> Option<String> {
    let (stored, root) = (stored.trim_matches(is_ws), root.trim_matches(is_ws));
    if stored.is_empty() || root.is_empty() {
        return None;
    }
    let root = lexical(Path::new(root))?;
    let abs = lexical(&root.join(stored))?;
    // `root + sep`: under a filesystem root (`/`, `C:\`) only the root itself matches.
    (abs == root || (root.parent().is_some() && abs.starts_with(&root)))
        .then(|| abs.to_string_lossy().into_owned())
}

/// `file` relative to `root` with `/` separators; `None` when it is the root or outside it.
pub fn relative_path_under_root(root: &str, file: &str) -> Option<String> {
    let root = lexical(Path::new(root.trim_matches(is_ws)))?;
    let abs = lexical(Path::new(file))?;
    let rel = abs
        .strip_prefix(&root)
        .ok()?
        .iter()
        .map(|c| c.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    (!rel.is_empty() && !rel.starts_with("..")).then_some(rel)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn drive_roots_resolve_and_relativise() {
        let l = r"C:\Fliks\medias";
        let abs = resolve_subtitle_absolute_path(l, "Movie/a.en.srt");
        assert_eq!(abs.as_deref(), Some(r"C:\Fliks\medias\Movie\a.en.srt"));
        assert_eq!(resolve_subtitle_absolute_path(l, "../x.srt"), None);
        assert_eq!(resolve_subtitle_absolute_path(r"C:\", "a.srt"), None);
        let rel = relative_path_under_root(l, r"C:\Fliks\medias\Movie\a.en.srt");
        assert_eq!(rel.as_deref(), Some("Movie/a.en.srt"));
        assert_eq!(relative_path_under_root(l, r"D:\Movie\a.srt"), None);
    }
}
