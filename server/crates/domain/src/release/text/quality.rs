//! `TEXT_QUALITIES` and `parse_text_release`: `source` is the format, `resolution` unused.
use crate::books::filename::BookNameGuess;
use crate::js::rx;
use crate::language::AppLanguage;
use crate::release::book::{parse_book_language, parse_book_release_name};
use crate::release::parsing::quality::AppQuality;
use serde::Serialize;

const fn q(id: u32, name: &'static str, source: &'static str, rank: u32) -> AppQuality {
    AppQuality {
        id,
        name,
        resolution: 0,
        source,
        rank,
    }
}

pub static TEXT_QUALITIES: [AppQuality; 7] = [
    q(201, "Unknown-text", "unknown", 5),
    q(202, "PDF", "pdf", 10),
    q(203, "MOBI", "mobi", 15),
    q(204, "AZW3", "azw3", 20),
    q(205, "EPUB", "epub", 30),
    q(206, "FB2", "fb2", 12),
    q(207, "CBZ", "cbz", 8),
];

pub fn text_quality_by_id(id: i64) -> Option<&'static AppQuality> {
    TEXT_QUALITIES.iter().find(|q| i64::from(q.id) == id)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRelease {
    pub quality: &'static AppQuality,
    pub format: Option<&'static str>,
    pub retail: bool,
    pub languages: Vec<&'static AppLanguage>,
    pub names: BookNameGuess,
}

pub fn parse_text_release(title: &str) -> TextRelease {
    let t = title.replace(['.', '_'], " ").to_lowercase();
    let format = [
        (rx!(r"\bepub\b"), "epub"),
        (rx!(r"\b(azw3|kf8)\b"), "azw3"),
        (rx!(r"\bmobi\b"), "mobi"),
        (rx!(r"\bpdf\b"), "pdf"),
        (rx!(r"\bfb2\b"), "fb2"),
        (rx!(r"\bcbz\b"), "cbz"),
    ]
    .into_iter()
    .find(|(r, _)| r.is_match(&t))
    .map(|(_, f)| f);
    TextRelease {
        quality: TEXT_QUALITIES
            .iter()
            .find(|q| Some(q.source) == format)
            .unwrap_or(&TEXT_QUALITIES[0]),
        format,
        retail: rx!(r"\bretail\b").is_match(&t) && !rx!(r"\bnon[ -]?retail\b").is_match(&t),
        languages: parse_book_language(title),
        names: parse_book_release_name(title),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::TEXT_EXTS;

    #[test]
    fn the_quality_table_and_the_ingested_formats_are_the_same_list() {
        for q in &TEXT_QUALITIES[1..] {
            assert!(TEXT_EXTS.contains(&format!(".{}", q.source).as_str()));
        }
        for e in TEXT_EXTS {
            let f = &e[1..];
            assert!(TEXT_QUALITIES.iter().any(|q| q.source == f), "{f}");
            assert_eq!(parse_text_release(&format!("T {f}")).format, Some(f));
        }
        assert_eq!(parse_text_release("T azw").format, None);
        assert_eq!(parse_text_release("T djvu").format, None);
    }
}
