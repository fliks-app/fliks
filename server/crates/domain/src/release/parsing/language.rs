//! Release language from keywords (`language.parser.ts`); short words that collide with English are frozen.
use crate::js::rx;
use crate::language::{
    APP_LANGUAGES, AppLanguage, ENGLISH_LANGUAGE, UNKNOWN_LANGUAGE, app_language_by_iso,
};

fn lang(iso: &str) -> &'static AppLanguage {
    app_language_by_iso(iso).unwrap_or(UNKNOWN_LANGUAGE)
}

pub fn parse_release_language(title: &str) -> &'static AppLanguage {
    let t = title.replace(['.', '_', '-'], " ").to_lowercase();
    let families: [(&regex::Regex, &str); 17] = [
        (
            rx!(r"\b(french|vff|vfi|vf\b|truefrench|vostfr|vost)\b"),
            "fr",
        ),
        (rx!(r"\b(german|deutsch)\b"), "de"),
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
    if let Some((_, iso)) = families.iter().find(|(r, _)| r.is_match(&t)) {
        return lang(iso);
    }
    if rx!(r"\bmulti\b").is_match(&t) {
        return UNKNOWN_LANGUAGE;
    }
    ENGLISH_LANGUAGE
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
