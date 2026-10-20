//! Text-rendition mapping of the HLS master; DB and disk access stay with the caller.
use crate::language::normalize_language_code;
use serde::{Deserialize, Serialize};

/// `path.extname` lower-cased: from the last dot of the basename, none for a leading dot.
fn extname(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

const IMAGE_CODECS: [&str; 4] = ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];
const TEXT_EXTENSIONS: [&str; 4] = [".srt", ".ass", ".ssa", ".vtt"];

pub fn is_image_based_codec(codec: Option<&str>) -> bool {
    codec.is_some_and(|c| IMAGE_CODECS.contains(&c))
}

/// A stream probed in the container.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedSubtitle {
    pub stream_index: i64,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default, deserialize_with = "crate::js::present")]
    pub language_tag: Option<Option<String>>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub is_image_based: Option<bool>,
    #[serde(default)]
    pub forced: Option<bool>,
}

/// A `subtitle_files` row.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSubtitle {
    pub id: i64,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub forced: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RenditionKind {
    Embedded,
    External,
}

/// A text subtitle track of the HLS master's `SUBTITLES` group.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleRendition {
    pub kind: RenditionKind,
    pub key: i64,
    pub language: String,
    /// Absent, null or a tag, as probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_tag: Option<Option<String>>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forced: Option<bool>,
}

fn is_renderable_text_sidecar(s: &ExternalSubtitle) -> bool {
    let Some(path) = &s.relative_path else {
        return false;
    };
    !is_image_based_codec(s.codec.as_deref()) && TEXT_EXTENSIONS.contains(&extname(path).as_str())
}

/// Embedded non-bitmap streams, then the external sidecars (in id order) that can become WebVTT.
pub fn text_subtitle_renditions(
    embedded: &[EmbeddedSubtitle],
    external: &[ExternalSubtitle],
) -> Vec<SubtitleRendition> {
    let non_empty = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    let embedded = embedded
        .iter()
        .filter(|s| s.is_image_based != Some(true))
        .map(|s| {
            let language = normalize_language_code(s.language.as_deref());
            SubtitleRendition {
                kind: RenditionKind::Embedded,
                key: s.stream_index,
                name: non_empty(&s.title).unwrap_or_else(|| language.clone()),
                language,
                language_tag: s.language_tag.clone(),
                forced: s.forced,
            }
        });
    let external = external
        .iter()
        .filter(|s| is_renderable_text_sidecar(s))
        .map(|s| SubtitleRendition {
            kind: RenditionKind::External,
            key: s.id,
            language: normalize_language_code(s.language.as_deref()),
            language_tag: None,
            name: non_empty(&s.language).unwrap_or_else(|| "Subtitle".into()),
            forced: s.forced,
        });
    embedded.chain(external).collect()
}
