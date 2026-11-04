//! `IMAGE_QUALITIES` and `parse_image_release`: `source` is the format, `resolution` unused.
use crate::js::rx;
use crate::language::AppLanguage;
use crate::release::book::parse_book_language;
use crate::release::comic::{ComicRelease, parse_comic_release};
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

pub static IMAGE_QUALITIES: [AppQuality; 5] = [
    q(301, "Unknown-image", "unknown", 5),
    q(302, "CBZ", "cbz", 30),
    q(303, "CBR", "cbr", 20),
    q(304, "CB7", "cb7", 25),
    q(305, "PDF", "pdf", 10),
];

pub fn image_quality_by_id(id: i64) -> Option<&'static AppQuality> {
    IMAGE_QUALITIES.iter().find(|q| i64::from(q.id) == id)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRelease {
    pub quality: &'static AppQuality,
    pub format: Option<&'static str>,
    pub languages: Vec<&'static AppLanguage>,
    pub comic: ComicRelease,
}

/// A name that names no format is a CBZ (indexers carry comics as archives and rarely say so), one that
/// names a book or audio format is `Unknown-image`, which no profile allows.
pub fn parse_image_release(title: &str) -> ImageRelease {
    let t = title.replace(['.', '_'], " ").to_lowercase();
    let format = [
        (rx!(r"\bcbz\b"), "cbz"),
        (rx!(r"\bcb7\b"), "cb7"),
        (rx!(r"\bcbr\b"), "cbr"),
        (rx!(r"\bpdf\b"), "pdf"),
    ]
    .into_iter()
    .find(|(r, _)| r.is_match(&t))
    .map(|(_, f)| f);
    let other = format.is_none()
        && rx!(r"\b(?:epub|mobi|azw3?|kf8|fb2|djvu|m4b|m4a|mp3|flac|ogg|opus|aac)\b").is_match(&t);
    ImageRelease {
        quality: IMAGE_QUALITIES
            .iter()
            .find(|q| Some(q.source) == format)
            .unwrap_or(&IMAGE_QUALITIES[if other { 0 } else { 1 }]),
        format,
        languages: parse_book_language(title),
        comic: parse_comic_release(title),
    }
}
