//! Group and channel name normalisation (`livetv-sources.md` rules 27-28, `livetv-access.md` rules 1-2).
use crate::js::{self, rx};
use unicode_normalization::UnicodeNormalization;

/// Stands in for the provider category of an entry that carries none.
pub const UNGROUPED: &str = "__livetv_ungrouped__";

/// JS `trim()`, or the sentinel when nothing is left.
pub fn normalize_group_name(raw: Option<&str>) -> String {
    let t = js::trim(raw.unwrap_or_default());
    if t.is_empty() { UNGROUPED } else { t }.to_owned()
}

/// Comparison key of a restriction: JS trim then lower case, accents kept.
pub fn fold_group_key(name: &str) -> String {
    js::trim(name).to_lowercase()
}

/// Comparison key of a channel name: two names with one key are one channel.
pub fn normalize_channel_name(raw: &str) -> String {
    let nfd: String = raw
        .to_lowercase()
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect();
    let s = rx!(r"\[[^\]]*\]|\([^)]*\)").replace_all(&nfd, " ");
    let s = rx!(r"^[a-z]{2,3}\s*[:|]\s*").replace(&s, "");
    let s = rx!(r"[^a-z0-9+]+").replace_all(&s, " ");
    let s = rx!(r"\b(?:fhd|uhd|hd|sd|4k|8k|1080p?|720p?|576p?|480p?|h265|hevc|h264|raw|backup|multi|vip|plus\+?)\b")
        .replace_all(&s, " ");
    let s = rx!(r"\s+").replace_all(&s, " ");
    js::trim(&s).to_owned()
}

/// Distinct tokens of a normalised name, in first-seen order.
pub fn name_tokens(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in normalize_channel_name(raw)
        .split(' ')
        .filter(|t| !t.is_empty())
    {
        if !out.iter().any(|o| o == t) {
            out.push(t.to_owned());
        }
    }
    out
}

/// Jaccard similarity of two token sets, 0 when either is empty.
pub fn token_similarity(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.iter().filter(|t| b.contains(t)).count();
    shared as f64 / (a.len() + b.len() - shared) as f64
}

pub fn name_similarity(a: &str, b: &str) -> f64 {
    token_similarity(&name_tokens(a), &name_tokens(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_names_trim_like_js() {
        assert_eq!(normalize_group_name(Some("XXX ")), "XXX");
        assert_eq!(normalize_group_name(Some("\u{feff}News\u{a0}")), "News");
        assert_eq!(normalize_group_name(Some("\u{85}")), "\u{85}");
        for empty in [None, Some(""), Some("   ")] {
            assert_eq!(normalize_group_name(empty), UNGROUPED);
        }
        assert_eq!(normalize_group_name(Some(" News  FR ")), "News  FR");
    }

    #[test]
    fn channel_names_fold_noise_case_and_accents() {
        assert_eq!(
            normalize_channel_name("FR: Canal+ Décalé FHD"),
            normalize_channel_name("canal+ decale")
        );
        assert_eq!(normalize_channel_name("One [Backup] (1080p)"), "one");
        assert_eq!(normalize_channel_name("Canal+"), "canal+");
        assert_eq!(normalize_channel_name("[HD] FR: x"), "fr x");
        assert_eq!(normalize_channel_name("Sport plus+"), "sport +");
    }

    #[test]
    fn similarity_is_jaccard_and_empty_safe() {
        assert_eq!(name_similarity("Sport One HD", "Sport One"), 1.0);
        assert_eq!(name_similarity("Sport One", "Movies Two"), 0.0);
        assert_eq!(name_similarity("", "One"), 0.0);
    }
}
