//! Release language from keywords (`language.parser.ts`); short words that collide with English are frozen.
use super::title::tag_region;
use crate::js::rx;
use crate::language::{
    APP_LANGUAGES, AppLanguage, ENGLISH_LANGUAGE, UNKNOWN_LANGUAGE, app_language_by_iso,
};

fn lang(iso: &str) -> &'static AppLanguage {
    app_language_by_iso(iso).unwrap_or(UNKNOWN_LANGUAGE)
}

/// Every language the title's tag region names (`tag_region`), in title order; `dual`, `multi` or an `N lang` count alone give Unknown.
pub fn parse_release_language(title: &str) -> Vec<&'static AppLanguage> {
    let t = tag_region(title)
        .replace(['.', '_', '-'], " ")
        .to_lowercase();
    let families: [(&regex::Regex, &str); 18] = [
        (
            rx!(r"\b(french|fre|fra|vff|vfi|vf\b|truefrench|vostfr|vost)\b"),
            "fr",
        ),
        (rx!(r"\b(english|eng)\b"), "en"),
        (rx!(r"\b(german|deutsch|ger|deu)\b"), "de"),
        (rx!(r"\b(spanish|espanol|esp\b|spa\b|latino)\b"), "es"),
        (rx!(r"\b(italian|italiano|ita\b)\b"), "it"),
        (
            rx!(r"\b(portuguese|portugu[eê]s|pt[\- ]br|ptbr|por\b)\b"),
            "pt",
        ),
        (rx!(r"\b(japanese|japon[ae]s|jap\b|jpn\b)\b"), "ja"),
        (rx!(r"\b(korean|cor[eé]en|kor\b)\b"), "ko"),
        (
            rx!(r"\b(chinese|chinois|chi\b|chn\b|mandarin|cantonese)\b"),
            "zh",
        ),
        (rx!(r"\b(russian|russe|rus\b)\b"), "ru"),
        (rx!(r"\b(arabic|arabe|ara\b)\b"), "ar"),
        (rx!(r"\b(dutch|nl\b|nlx|flemish)\b"), "nl"),
        (rx!(r"\b(polish|polonais|pol\b|pl\b)\b"), "pl"),
        (rx!(r"\b(turkish|turc|tur\b)\b"), "tr"),
        (rx!(r"\b(swedish|su[eè]dois|swe\b|sv\b)\b"), "sv"),
        (rx!(r"\b(danish|danois|dan\b|dk\b)\b"), "da"),
        (rx!(r"\b(norwegian|norv[eé]gien|nor\b|no\b)\b"), "no"),
        (rx!(r"\b(finnish|finlandais|fin\b)\b"), "fi"),
    ];
    let mut found: Vec<(usize, &str)> = families
        .iter()
        .filter_map(|(r, iso)| r.find(&t).map(|m| (m.start(), *iso)))
        .collect();
    found.sort_by_key(|(at, _)| *at);
    if !found.is_empty() {
        return found.into_iter().map(|(_, iso)| lang(iso)).collect();
    }
    if rx!(r"\b(multi|dual|([2-9]|\d{2,}) langs?)\b").is_match(&t) {
        return vec![UNKNOWN_LANGUAGE];
    }
    vec![ENGLISH_LANGUAGE]
}

/// A source's `unknown_iso` replaces an Unknown parse; anything else is kept.
pub fn resolve_unknown_language(
    parsed: &'static AppLanguage,
    unknown_iso: Option<&str>,
) -> &'static AppLanguage {
    match unknown_iso {
        Some(iso) if parsed.id == UNKNOWN_LANGUAGE.id && !iso.is_empty() => APP_LANGUAGES
            .iter()
            .find(|l| l.iso_code == iso)
            .unwrap_or(parsed),
        _ => parsed,
    }
}

/// `resolve_unknown_language` over a list.
pub fn resolve_unknown_languages(
    parsed: Vec<&'static AppLanguage>,
    unknown_iso: Option<&str>,
) -> Vec<&'static AppLanguage> {
    parsed
        .into_iter()
        .map(|l| resolve_unknown_language(l, unknown_iso))
        .collect()
}
