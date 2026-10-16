//! Quality name from real pixels plus the source tag of a name (`quality-from-resolution.ts`).
use super::quality::APP_QUALITIES;
use crate::js::rx;

/// Canonical height step of a width x height pair; 480 when both are 0 or absent.
pub fn bucket_resolution_height(width: Option<f64>, height: Option<f64>) -> u32 {
    let (w, h) = (width.unwrap_or(0.0), height.unwrap_or(0.0));
    if w == 0.0 && h == 0.0 {
        return 480;
    }
    const STEPS: [(f64, f64, u32); 6] = [
        (256.0, 192.0, 144),
        (426.0, 320.0, 240),
        (640.0, 432.0, 360),
        (854.0, 576.0, 480),
        (1280.0, 962.0, 720),
        (1920.0, 1440.0, 1080),
    ];
    STEPS
        .iter()
        .find(|(mw, mh, _)| w <= *mw && h <= *mh)
        .map_or(2160, |s| s.2)
}

pub fn quality_from_resolution(
    source_text: &str,
    width: Option<f64>,
    height: Option<f64>,
) -> String {
    let resolution = bucket_resolution_height(width, height).clamp(480, 2160);
    let t = source_text.replace('.', " ").to_lowercase();
    let source = if rx!(r"\bremux\b").is_match(&t) {
        "remux"
    } else if rx!(r"\b(bluray|blu-?ray|bdrip|brrip)\b").is_match(&t) {
        "bluray"
    } else if rx!(r"\bweb-?dl\b").is_match(&t) || rx!(r"\bweb-?rip\b").is_match(&t) {
        "web"
    } else if rx!(r"\b(dvd|dvdrip)\b").is_match(&t) {
        "dvd"
    } else {
        "hdtv"
    };
    APP_QUALITIES
        .iter()
        .find(|q| q.resolution == resolution && q.source == source)
        .or_else(|| APP_QUALITIES.iter().find(|q| q.resolution == resolution))
        .map_or_else(|| format!("HDTV-{resolution}p"), |q| q.name.to_owned())
}
