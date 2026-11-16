//! The prefix tsquery of the media search (`applyFullTextSearch`, rule 24).
use crate::js;
use regex::Regex;
use std::sync::LazyLock;

static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").expect("static"));

/// `word:* & word:*`, or `""` when no word survives (the caller then uses `plainto_tsquery`).
pub fn prefix_tsquery(q: &str) -> String {
    js::trim(q)
        .split(js::is_ws)
        .map(|w| NON_ALNUM.replace_all(w, ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("{w}:*"))
        .collect::<Vec<_>>()
        .join(" & ")
}

/// Tags and keyboards disagree on which one they type, so a search matches any of them for any other.
pub const APOSTROPHES: [char; 4] = ['\'', '’', '‘', 'ʼ'];

/// The `ILIKE` pattern of a text contained anywhere: `%`, `_` and `\` literal, an apostrophe any apostrophe.
pub fn contains_pattern(q: &str) -> String {
    let mut p = String::from("%");
    for c in q.chars() {
        match c {
            c if APOSTROPHES.contains(&c) => p.push('_'),
            '%' | '_' | '\\' => {
                p.push('\\');
                p.push(c);
            }
            _ => p.push(c),
        }
    }
    p.push('%');
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_contains_pattern_escapes_wildcards_and_folds_apostrophes() {
        assert_eq!(contains_pattern(r"a%b_c\d"), r"%a\%b\_c\\d%");
        assert_eq!(contains_pattern("J'ai"), "%J_ai%");
        assert_eq!(contains_pattern("J’ai"), "%J_ai%");
    }

    #[test]
    fn words_get_a_prefix_star() {
        assert_eq!(prefix_tsquery("  star   wars "), "star:* & wars:*");
        assert_eq!(prefix_tsquery("l'impossible"), "limpossible:*");
        assert_eq!(prefix_tsquery("!!!"), "");
    }
}
