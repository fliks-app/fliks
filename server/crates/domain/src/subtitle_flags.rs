//! Subtitle flags, codecs and language coverage (`subtitle-flags.ts`, `subtitle-codecs.ts`).
use crate::burn_in::is_image_based_codec;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HiMode {
    Prefer,
    Avoid,
    Require,
    Forbid,
}

/// A profile language item (`language_profiles.subtitleLanguages[]`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageItem {
    #[serde(default)]
    pub iso_code: String,
    #[serde(default)]
    pub forced: Option<bool>,
    #[serde(default)]
    pub hi: Option<bool>,
    #[serde(default, deserialize_with = "lenient_mode")]
    pub hearing_impaired: Option<HiMode>,
}

/// An unknown mode string reads as absent (the item then follows `hi`).
fn lenient_mode<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<HiMode>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

impl LanguageItem {
    pub fn hi_mode(&self) -> HiMode {
        self.hearing_impaired
            .unwrap_or(if self.hi.unwrap_or(false) {
                HiMode::Prefer
            } else {
                HiMode::Avoid
            })
    }

    pub fn request_flags(&self) -> RequestFlags {
        RequestFlags {
            forced: Some(self.forced.unwrap_or(false)),
            hearing_impaired_mode: Some(self.hi_mode()),
        }
    }
}

/// What a request asks for beyond the language.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestFlags {
    pub forced: Option<bool>,
    pub hearing_impaired_mode: Option<HiMode>,
}

/// A stored row, an embedded track or a provider candidate.
#[derive(Debug, Clone, Copy, Default)]
pub struct Flags {
    pub forced: bool,
    pub hearing_impaired: bool,
}

/// A stated `forced` is an exact match both ways; HI `require`/`forbid` are hard filters.
pub fn matches_requested_flags(sub: Flags, req: RequestFlags) -> bool {
    if req.forced.is_some_and(|f| sub.forced != f) {
        return false;
    }
    match req.hearing_impaired_mode.unwrap_or(HiMode::Avoid) {
        HiMode::Require => sub.hearing_impaired,
        HiMode::Forbid => !sub.hearing_impaired,
        _ => true,
    }
}

pub fn prefers_hearing_impaired(req: RequestFlags) -> bool {
    matches!(
        req.hearing_impaired_mode.unwrap_or(HiMode::Avoid),
        HiMode::Require | HiMode::Prefer
    )
}

pub const IMAGE_BASED_CODECS: [&str; 4] =
    ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];
pub const OCR_CODECS: [&str; 2] = ["hdmv_pgs_subtitle", "dvd_subtitle"];
pub const TEXT_EXTENSIONS: [&str; 4] = [".srt", ".ass", ".ssa", ".vtt"];

pub fn is_ocr_supported_codec(codec: Option<&str>) -> bool {
    codec.is_some_and(|c| OCR_CODECS.contains(&c))
}

/// Codec of a bitmap sidecar; a `.sub` is VobSub only next to its `.idx`.
pub fn external_image_codec(ext: &str, has_idx: bool) -> Option<&'static str> {
    match ext {
        ".sup" => Some("hdmv_pgs_subtitle"),
        ".sub" if has_idx => Some("dvd_subtitle"),
        _ => None,
    }
}

/// A servable-subtitle probe for `has_covering_sub`.
#[derive(Debug, Clone)]
pub struct Servable<'a> {
    pub language: &'a str,
    pub forced: bool,
    pub hearing_impaired: bool,
    pub codec: Option<&'a str>,
    pub status: Option<&'a str>,
}

/// Only `forced` decides coverage: the HI mode picks what to fetch, and cleaning clears the flag.
pub fn has_covering_sub(subs: &[Servable], item: &LanguageItem, image_tracks_count: bool) -> bool {
    let req = RequestFlags {
        forced: Some(item.forced.unwrap_or(false)),
        hearing_impaired_mode: None,
    };
    subs.iter().any(|s| {
        s.language == item.iso_code
            && matches_requested_flags(
                Flags {
                    forced: s.forced,
                    hearing_impaired: s.hearing_impaired,
                },
                req,
            )
            && (image_tracks_count || !is_image_based_codec(s.codec))
            && s.status != Some("failed")
    })
}
