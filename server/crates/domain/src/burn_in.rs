//! Subtitle burn-in filter building and the text-rendition mapping; DB and disk access stay with the caller.
use crate::language::normalize_language_code;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BurnInType {
    Text,
    Image,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnInInfo {
    #[serde(rename = "type")]
    pub kind: BurnInType,
    pub video_path: String,
    #[serde(default)]
    pub subtitle_path: Option<String>,
    #[serde(default)]
    pub subtitle_ordinal: Option<u32>,
    /// Source time cue 0 of a text file sits at (the container start).
    #[serde(default)]
    pub cue_offset_seconds: Option<f64>,
}

/// JS `toFixed(6)` rounds an exact tie up; Rust rounds it to even.
fn to_fixed6(v: f64) -> String {
    let tie = (v * 128.0).fract() == 0.0 && format!("{v:.7}").ends_with('5');
    format!("{:.6}", if tie { v + 1e-9 } else { v })
}

/// Seconds as a signed `setpts` term, microsecond precision.
fn pts_term(sign: f64, seconds: f64) -> String {
    let v = sign * seconds;
    let n: f64 = to_fixed6(v.abs()).parse().unwrap_or(0.0);
    format!("{}{n}/TB", if v < 0.0 { '-' } else { '+' })
}

/// Renders `subtitle_filter` against cue time: under `-copyts` frames carry source PTS.
pub fn at_cue_time(subtitle_filter: &str, cue_offset_seconds: f64) -> String {
    if cue_offset_seconds == 0.0 {
        return subtitle_filter.to_owned();
    }
    format!(
        "setpts=PTS{},{subtitle_filter},setpts=PTS{}",
        pts_term(-1.0, cue_offset_seconds),
        pts_term(1.0, cue_offset_seconds)
    )
}

fn escape(path: &str) -> String {
    path.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "'\\''")
}

/// `path.extname` lower-cased: from the last dot of the basename, none for a leading dot.
fn extname(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// The `-vf` filter for text burn-in; `None` for image subtitles (overlaid by the engine).
pub fn build_filter(info: &BurnInInfo) -> Option<String> {
    if info.kind != BurnInType::Text {
        return None;
    }
    if let Some(path) = &info.subtitle_path {
        let esc = escape(path);
        let filter = match extname(path).as_str() {
            ".ass" | ".ssa" => format!("ass='{esc}'"),
            _ => format!("subtitles='{esc}'"),
        };
        return Some(at_cue_time(&filter, info.cue_offset_seconds.unwrap_or(0.0)));
    }
    // Embedded text: the video file is the subtitle source.
    info.subtitle_ordinal
        .map(|o| format!("subtitles='{}':si={o}", escape(&info.video_path)))
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
