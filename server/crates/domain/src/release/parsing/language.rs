//! Release language from keywords (`language.parser.ts`); short words that collide with English are frozen.
use super::title::decoded_with_tag_start;
use crate::js::rx;
use crate::language::{
    APP_LANGUAGES, AppLanguage, ENGLISH_LANGUAGE, UNKNOWN_LANGUAGE, app_language_by_iso,
};

fn lang(iso: &str) -> &'static AppLanguage {
    app_language_by_iso(iso).unwrap_or(UNKNOWN_LANGUAGE)
}

/// Languages named in the title in title order: full words anywhere, short codes only in the tag
/// region (after the work title). `dual`, `multi` or an `N lang` count alone give Unknown.
pub fn parse_release_language(title: &str) -> Vec<&'static AppLanguage> {
    let (decoded, tag_start) = decoded_with_tag_start(title);
    let norm = |s: &str| s.replace(['.', '_', '-'], " ").to_lowercase();
    let t = norm(&decoded);
    let tag_at = norm(&decoded[..tag_start]).len();
    let families: [(&regex::Regex, &regex::Regex, &str); 18] = [
        (
            rx!(r"\b(french|vff|vfi|truefrench|vostfr|vost)\b"),
            rx!(r"\b(fre|fra|vf)\b"),
            "fr",
        ),
        (rx!(r"\b(english)\b"), rx!(r"\b(eng)\b"), "en"),
        (rx!(r"\b(german|deutsch)\b"), rx!(r"\b(ger|deu)\b"), "de"),
        (
            rx!(r"\b(spanish|espanol|latino)\b"),
            rx!(r"\b(esp|spa)\b"),
            "es",
        ),
        (rx!(r"\b(italian|italiano)\b"), rx!(r"\b(ita)\b"), "it"),
        (
            rx!(r"\b(portuguese|portugu[eê]s)\b"),
            rx!(r"\b(pt[\- ]br|ptbr|por)\b"),
            "pt",
        ),
        (
            rx!(r"\b(japanese|japon[ae]s)\b"),
            rx!(r"\b(jap|jpn)\b"),
            "ja",
        ),
        (rx!(r"\b(korean|cor[eé]en)\b"), rx!(r"\b(kor)\b"), "ko"),
        (
            rx!(r"\b(chinese|chinois|mandarin|cantonese)\b"),
            rx!(r"\b(chi|chn)\b"),
            "zh",
        ),
        (rx!(r"\b(russian|russe)\b"), rx!(r"\b(rus)\b"), "ru"),
        (rx!(r"\b(arabic|arabe)\b"), rx!(r"\b(ara)\b"), "ar"),
        (rx!(r"\b(dutch|flemish)\b"), rx!(r"\b(nl|nlx)\b"), "nl"),
        (rx!(r"\b(polish|polonais)\b"), rx!(r"\b(pol|pl)\b"), "pl"),
        (rx!(r"\b(turkish|turc)\b"), rx!(r"\b(tur)\b"), "tr"),
        (rx!(r"\b(swedish|su[eè]dois)\b"), rx!(r"\b(swe|sv)\b"), "sv"),
        (rx!(r"\b(danish|danois)\b"), rx!(r"\b(dan|dk)\b"), "da"),
        (
            rx!(r"\b(norwegian|norv[eé]gien)\b"),
            rx!(r"\b(nor|no)\b"),
            "no",
        ),
        (rx!(r"\b(finnish|finlandais)\b"), rx!(r"\b(fin)\b"), "fi"),
    ];
    let mut found: Vec<(usize, &str)> = families
        .iter()
        .filter_map(|(long, short, iso)| {
            let word = long.find(&t).map(|m| m.start());
            let code = short.find(&t[tag_at..]).map(|m| tag_at + m.start());
            word.into_iter().chain(code).min().map(|at| (at, *iso))
        })
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
