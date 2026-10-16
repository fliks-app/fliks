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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_get_a_prefix_star() {
        assert_eq!(prefix_tsquery("  star   wars "), "star:* & wars:*");
        assert_eq!(prefix_tsquery("l'impossible"), "limpossible:*");
        assert_eq!(prefix_tsquery("!!!"), "");
    }
}
