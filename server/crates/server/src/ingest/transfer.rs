//! `FileTransferService` (`ingest.md` rules 9-16): video and companion transfers, never replacing.
use super::fsx;
use sqlx::PgPool;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Copy,
    Move,
}

const DEFAULT_COMPANIONS: &str = ".srt,.ass,.ssa,.vtt,.idx,.sub,.nfo,.jpg,.jpeg,.png,.webp,.edl";

/// Rule 16: a stored empty value means no companions at all.
pub async fn companion_exts(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let v = sqlx::query_scalar!(
        r#"SELECT value FROM app_settings WHERE key = 'companion_file_extensions' LIMIT 1"#
    )
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(parse_exts(v.as_deref().unwrap_or(DEFAULT_COMPANIONS)))
}

fn parse_exts(v: &str) -> Vec<String> {
    v.split(',')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .map(|e| {
            if e.starts_with('.') {
                e
            } else {
                format!(".{e}")
            }
        })
        .collect()
}

/// Rule 9: `dest` must not exist unless `replace`; `Ok(false)` = already present, nothing written.
pub fn transfer_file(src: &Path, dest: &Path, method: Method, replace: bool) -> io::Result<bool> {
    match (method, replace) {
        (Method::Copy, false) => fsx::copy_noreplace(src, dest),
        (Method::Copy, true) => fsx::copy_replace(src, dest).map(|()| true),
        (Method::Move, r) => fsx::move_file(src, dest, r),
    }
}

/// The trailing language hint of a stem (`.en`, `.en.hi.forced`): `\.([a-z]{2,3}(?:\.[a-z]+){0,2})$`/i.
pub fn language_hint(stem: &str) -> Option<&str> {
    let alpha = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic());
    stem.match_indices('.')
        .map(|(i, _)| &stem[i + 1..])
        .find(|rest| {
            let parts: Vec<&str> = rest.split('.').collect();
            parts.len() <= 3 && (2..=3).contains(&parts[0].len()) && parts.iter().all(|p| alpha(p))
        })
}

/// `(stem, ext)` with `path.extname` semantics; the extension keeps its case.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

pub struct Companions<'a> {
    pub src_dir: &'a Path,
    pub dest_dir: &'a Path,
    pub source_base: &'a str,
    pub new_base: &'a str,
    pub method: Method,
    pub allowed: &'a [String],
}

/// Rules 14-15 (W5): every failure is logged and skipped; nothing existing is ever replaced.
pub fn transfer_companions(c: &Companions) {
    let Ok(entries) = fs::read_dir(c.src_dir) else {
        return;
    };
    let entries: Vec<_> = entries.flatten().collect();
    let base = c.source_base.to_lowercase();
    let longer: Vec<String> = entries
        .iter()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| super::is_video(n))
        .map(|n| split_ext(&n).0.to_lowercase())
        .filter(|s| s.len() > base.len() && s.starts_with(&base))
        .collect();
    for e in entries {
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(name) = e.file_name().into_string() else {
            continue;
        };
        let (stem, ext) = split_ext(&name);
        let (stem_l, ext_l) = (stem.to_lowercase(), ext.to_lowercase());
        if !c.allowed.contains(&ext_l) || !stem_l.starts_with(&base) {
            continue;
        }
        let exact = stem_l == base;
        if (ext_l == ".edl" && !exact) || super::is_video(&name) {
            continue;
        }
        if longer.iter().any(|l| stem_l.starts_with(l.as_str())) {
            tracing::warn!("companion \"{name}\" belongs to a longer-named video, skipped");
            continue;
        }
        let dest_name = match language_hint(stem).filter(|_| !exact) {
            Some(h) => format!("{}.{h}{ext}", c.new_base),
            None => format!("{}{ext}", c.new_base),
        };
        let dest: PathBuf = c.dest_dir.join(&dest_name);
        match transfer_file(&e.path(), &dest, c.method, false) {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!("companion \"{dest_name}\" already exists, \"{name}\" kept")
            }
            Err(err) => tracing::warn!("companion \"{name}\" not transferred: {err}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_matches_the_ts_regex() {
        assert_eq!(language_hint("Movie.en.hi.forced"), Some("en.hi.forced"));
        assert_eq!(language_hint("Movie.2020.en"), Some("en"));
        assert_eq!(language_hint("x.eng.forced.sdh.extra"), Some("sdh.extra"));
        assert_eq!(language_hint("Movie"), None);
        assert_eq!(language_hint("Movie.e"), None);
        assert_eq!(parse_exts(" SRT, .Nfo,,"), vec![".srt", ".nfo"]);
        assert!(parse_exts("").is_empty());
        assert_eq!(split_ext("a.MKV"), ("a", ".MKV"));
        assert_eq!(split_ext(".hidden"), (".hidden", ""));
    }
}
