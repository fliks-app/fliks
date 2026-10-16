//! Codec detection and size-per-hour helpers (`release-rejection.helper.ts`).
use crate::js::rx;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SizeLimits {
    pub min: f64,
    pub preferred: f64,
    pub max: f64,
}

pub fn detect_video_codec(title: Option<&str>) -> Option<&'static str> {
    let t = title.filter(|t| !t.is_empty())?.to_lowercase();
    if rx!(r"\bav1\b").is_match(&t) {
        Some("AV1")
    } else if rx!(r"\b(x265|h[.\s-]?265|hevc)\b").is_match(&t) {
        Some("HEVC")
    } else if rx!(r"\bvp9\b").is_match(&t) {
        Some("VP9")
    } else if rx!(r"\b(x264|h[.\s-]?264|avc)\b").is_match(&t) {
        Some("x264")
    } else {
        None
    }
}

/// Size limits are calibrated for x264; newer codecs get smaller files.
pub fn detect_codec_size_factor(title: Option<&str>) -> f64 {
    match detect_video_codec(title) {
        Some("AV1") => 0.45,
        Some("HEVC") => 0.55,
        Some("VP9") => 0.6,
        _ => 1.0,
    }
}

/// `abs(MB/h - preferred) / preferred`, codec-adjusted; `None` when it cannot be computed.
pub fn compute_size_deviation(
    title: &str,
    size_bytes: f64,
    runtime_minutes: f64,
    limits: Option<&SizeLimits>,
) -> Option<f64> {
    let limits = limits.filter(|l| l.preferred > 0.0)?;
    if runtime_minutes <= 0.0 || size_bytes <= 0.0 {
        return None;
    }
    let mb_per_hour = (size_bytes / 1_048_576.0) / (runtime_minutes / 60.0);
    let preferred = limits.preferred * detect_codec_size_factor(Some(title));
    (preferred > 0.0).then(|| (mb_per_hour - preferred).abs() / preferred)
}
