//! Sidecar subtitle names (`parseSubtitleFilename`, `matchSubtitleVideo`): shared by the companion
//! listing (S5) and subtitle discovery (S6).
use crate::language::APP_LANGUAGES;

pub const SUBTITLE_EXTS: [&str; 6] = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".sup"];
const FORCED: [&str; 2] = ["forced", "foreign"];
const HI: [&str; 3] = ["hi", "cc", "sdh"];
const SKIP: [&str; 2] = ["default", "ocr"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleName {
    pub language: String,
    pub forced: bool,
    pub hearing_impaired: bool,
    /// Index of the HI token in the dot-separated name.
    pub hi_part: Option<usize>,
}

/// `path.extname` lowercased (a leading dot is not an extension).
fn ext(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn language_of(token: &str) -> Option<String> {
    let alpha = |s: &str| s.bytes().all(|b| b.is_ascii_lowercase());
    if token.len() == 2 && alpha(token) && APP_LANGUAGES.iter().any(|l| l.iso_code == token) {
        return Some(token.to_owned());
    }
    if let Some((a, b)) = token.split_once('-')
        && a.len() == 2
        && a.bytes().all(|c| c.is_ascii_alphabetic())
        && b.len() >= 2
        && b.bytes().all(|c| c.is_ascii_alphabetic())
    {
        return Some(a.to_lowercase());
    }
    APP_LANGUAGES
        .iter()
        .find(|l| l.iso639_2.is_some_and(|c| c.contains(&token)))
        .or_else(|| {
            APP_LANGUAGES
                .iter()
                .find(|l| l.iso_code != "xx" && l.name.to_lowercase() == token)
        })
        .map(|l| l.iso_code.to_owned())
}

/// `<video>.<lang>.<flags>.<ext>` read right to left; `None` unless a subtitle extension.
pub fn parse_subtitle_filename(name: &str) -> Option<SubtitleName> {
    let e = ext(name);
    if !SUBTITLE_EXTS.contains(&e.as_str()) {
        return None;
    }
    let parts: Vec<&str> = name[..name.len() - e.len()].split('.').collect();
    let mut out = SubtitleName {
        language: "und".into(),
        forced: false,
        hearing_impaired: false,
        hi_part: None,
    };
    let mut hi_candidate = None;
    for i in (1..parts.len()).rev() {
        let t = parts[i].to_lowercase();
        if FORCED.contains(&t.as_str()) {
            out.forced = true;
        } else if HI.contains(&t.as_str()) {
            // A lone `hi` is Hindi; followed by a language further left it is the HI flag.
            if t == "hi" && out.language == "und" {
                out.language = "hi".into();
                hi_candidate = Some(i);
            } else {
                out.hearing_impaired = true;
                out.hi_part = Some(i);
            }
        } else if SKIP.contains(&t.as_str()) {
        } else if let Some(l) = language_of(&t) {
            out.language = l;
            if let Some(c) = hi_candidate.take() {
                out.hearing_impaired = true;
                out.hi_part = Some(c);
            }
        } else {
            break;
        }
    }
    Some(out)
}

/// `path.basename(p, path.extname(p))` lowercased.
fn base_lower(p: &str) -> String {
    let b = p.rsplit('/').next().unwrap_or(p);
    let e = ext(b);
    b[..b.len() - e.len()].to_lowercase()
}

/// Index in `files` (`(relativePath, in the sidecar's dir)`) of the video whose base name is the
/// longest dot-prefix of `entry`, else the lone video of its dir when the media has its own folder.
pub fn match_subtitle_video(
    entry: &str,
    files: &[(&str, bool)],
    has_own_folder: bool,
) -> Option<usize> {
    let mut by_base = std::collections::HashMap::new();
    for (i, (rel, _)) in files.iter().enumerate() {
        by_base.insert(base_lower(rel), i);
    }
    let e = ext(entry);
    // `path.basename(entry, ext)` strips only a same-case suffix: `Movie.SRT` keeps `.srt` as a part.
    let lower = entry
        .strip_suffix(e.as_str())
        .unwrap_or(entry)
        .to_lowercase();
    let parts: Vec<&str> = lower.split('.').collect();
    for len in (1..parts.len()).rev() {
        if let Some(&i) = by_base.get(&parts[..len].join(".")) {
            return Some(i);
        }
    }
    if !has_own_folder {
        return None;
    }
    let in_dir: Vec<usize> = (0..files.len()).filter(|&i| files[i].1).collect();
    match (in_dir.as_slice(), files.len()) {
        ([one], _) => Some(*one),
        ([], 1) => Some(0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags_right_to_left() {
        let p = parse_subtitle_filename("Movie.en.hi.forced.srt").unwrap();
        assert_eq!(
            (p.language.as_str(), p.forced, p.hearing_impaired, p.hi_part),
            ("en", true, true, Some(2))
        );
        let p = parse_subtitle_filename("Movie.hi.srt").unwrap();
        assert_eq!((p.language.as_str(), p.hearing_impaired), ("hi", false));
        assert_eq!(
            parse_subtitle_filename("Movie.fre.srt").unwrap().language,
            "fr"
        );
        assert_eq!(
            parse_subtitle_filename("Movie.en-US.srt").unwrap().language,
            "en"
        );
        assert_eq!(
            parse_subtitle_filename("Movie.French.srt")
                .unwrap()
                .language,
            "fr"
        );
        assert_eq!(
            parse_subtitle_filename("Movie.srt").unwrap().language,
            "und"
        );
        assert!(parse_subtitle_filename("Movie.nfo").is_none());
    }

    #[test]
    fn matches_longest_prefix_then_lone_video() {
        let files = [("A (2020).mkv", true), ("A (2020).cut.mkv", true)];
        assert_eq!(
            match_subtitle_video("A (2020).cut.en.srt", &files, true),
            Some(1)
        );
        assert_eq!(
            match_subtitle_video("A (2020).en.srt", &files, true),
            Some(0)
        );
        assert_eq!(match_subtitle_video("other.srt", &files, true), None);
        assert_eq!(match_subtitle_video("A (2020).SRT", &files, true), Some(0));
        assert_eq!(
            match_subtitle_video("other.srt", &files[..1], true),
            Some(0)
        );
        assert_eq!(match_subtitle_video("other.srt", &files[..1], false), None);
    }
}
