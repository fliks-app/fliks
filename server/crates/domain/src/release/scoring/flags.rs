//! Flags, allowed sets and the best resolution on disk (`release-rejection.helper.ts`).
use crate::language::APP_LANGUAGES;
use crate::release::parsing::quality::parse_release_quality;
use serde::Deserialize;
use std::collections::BTreeSet;

/// `flags` (first occurrence order) plus `freeleech` / `halfleech` from the volume factor.
pub fn release_flags(
    flags: &[String],
    freeleech: Option<bool>,
    download_volume_factor: Option<f64>,
) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let factor = download_volume_factor;
    let extra = [
        (freeleech == Some(true) || factor == Some(0.0)).then_some("freeleech"),
        (factor == Some(0.5)).then_some("halfleech"),
    ];
    for f in flags
        .iter()
        .map(String::as_str)
        .chain(extra.into_iter().flatten())
    {
        if !out.iter().any(|o| o == f) {
            out.push(f.to_owned());
        }
    }
    out
}

pub fn max_resolution_from_quality_strings(files: &[Option<&str>]) -> u32 {
    files
        .iter()
        .map(|q| parse_release_quality(q.unwrap_or("")).quality.resolution)
        .max()
        .unwrap_or(0)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLanguageItem {
    pub iso_code: String,
}

/// Empty set = no language restriction (also when no code is known).
pub fn allowed_audio_language_ids(items: &[AudioLanguageItem]) -> BTreeSet<u32> {
    items
        .iter()
        .filter_map(|i| APP_LANGUAGES.iter().find(|l| l.iso_code == i.iso_code))
        .map(|l| l.id)
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileQuality {
    pub id: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityProfileItem {
    pub quality: ProfileQuality,
    pub allowed: bool,
    #[serde(default)]
    pub group_id: Option<i64>,
}

/// One allowed member allows its whole group; empty items allow nothing.
pub fn build_allowed_quality_ids(items: &[QualityProfileItem]) -> BTreeSet<u32> {
    let groups: BTreeSet<i64> = items
        .iter()
        .filter(|i| i.allowed)
        .filter_map(|i| i.group_id)
        .collect();
    items
        .iter()
        .filter(|i| i.allowed || i.group_id.is_some_and(|g| groups.contains(&g)))
        .map(|i| i.quality.id)
        .collect()
}
