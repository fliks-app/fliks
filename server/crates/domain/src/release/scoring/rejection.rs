//! Why a release is not a perfect match (`computeRejections`, `release-rejection.helper.ts`).
use super::sizes::{SizeLimits, detect_codec_size_factor};
use super::titles::*;
use crate::js::round;
use crate::release::parsing::quality::parse_release_quality;
use crate::release::parsing::season_episode::{ReleaseCoverage, release_coverage, within};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Param {
    Num(i64),
    Str(String),
}

/// `code` is the contract with the client's i18n; `params` feed its interpolation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReleaseRejection {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<&'static str, Param>>,
}

fn rej(code: &str, params: Vec<(&'static str, Param)>) -> ReleaseRejection {
    ReleaseRejection {
        code: code.to_owned(),
        params: (!params.is_empty()).then(|| params.into_iter().collect()),
    }
}

/// `string | string[]` on the wire.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ExpectedTitle {
    One(String),
    Many(Vec<String>),
}

impl ExpectedTitle {
    /// JS truthiness: `""` is falsy, `[]` is not.
    fn truthy(&self) -> bool {
        !matches!(self, Self::One(s) if s.is_empty())
    }

    pub fn as_slice(&self) -> &[String] {
        match self {
            Self::One(s) => std::slice::from_ref(s),
            Self::Many(v) => v,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionInput {
    pub quality_id: u32,
    pub allowed: BTreeSet<u32>,
    pub language_id: u32,
    pub allowed_langs: BTreeSet<u32>,
    pub is_blocklisted: bool,
    pub size_bytes: f64,
    pub runtime_minutes: f64,
    pub size_by_quality: BTreeMap<u32, SizeLimits>,
    pub seeders: i64,
    pub source_id: i64,
    pub source_min_seeders: BTreeMap<i64, i64>,
    #[serde(default)]
    pub release_title: Option<String>,
    #[serde(default)]
    pub coverage: Option<ReleaseCoverage>,
    #[serde(default)]
    pub expected_title: Option<ExpectedTitle>,
    #[serde(default)]
    pub expected_season: Option<i64>,
    #[serde(default)]
    pub expected_episode: Option<i64>,
    #[serde(default)]
    pub min_resolution: Option<i64>,
    #[serde(default)]
    pub expected_year: Option<i64>,
    #[serde(default)]
    pub custom_format_score: Option<i64>,
    #[serde(default)]
    pub min_custom_format_score: Option<i64>,
    #[serde(default)]
    pub rank: Option<i64>,
    #[serde(default)]
    pub min_rank_exclusive: Option<i64>,
    #[serde(default)]
    pub max_rank_inclusive: Option<i64>,
}

/// `S04E03`, `S04`, `E03`, `?`; ranges `S01-S03`, `S01E04-E05`.
fn format_season_episode(
    season: Option<i64>,
    episode: Option<i64>,
    season_end: Option<i64>,
    episode_end: Option<i64>,
) -> String {
    let n = |v: i64| format!("{v:0>2}");
    let Some(season) = season else {
        return episode.map_or("?".into(), |e| format!("E{}", n(e)));
    };
    let s = match season_end {
        Some(end) => format!("S{}-S{}", n(season), n(end)),
        None => format!("S{}", n(season)),
    };
    match (episode, episode_end) {
        (None, _) => s,
        (Some(e), Some(end)) => format!("{s}E{}-E{}", n(e), n(end)),
        (Some(e), None) => format!("{s}E{}", n(e)),
    }
}

fn format_coverage(c: &ReleaseCoverage) -> String {
    format_season_episode(
        c.seasons.map(|s| s.from),
        c.episodes.map(|e| e.from),
        c.seasons.filter(|s| s.to > s.from).map(|s| s.to),
        c.episodes.filter(|e| e.to > e.from).map(|e| e.to),
    )
}

fn title_block(
    o: &RejectionInput,
    expected: &ExpectedTitle,
    title: &str,
    out: &mut Vec<ReleaseRejection>,
) {
    let index = index_title_expectations(expected.as_slice());
    let matches = if index.readings.is_empty() {
        folded_contains(&index, title)
    } else {
        matches_indexed_expectation(&release_title_tokens(title), &index, WhenUnreadable::Match)
    };
    if !matches {
        out.push(rej("TITLE_MISMATCH", vec![]));
        return;
    }
    if let Some(n) = appended_sequel_number(title, &index) {
        out.push(rej("SEQUEL_MISMATCH", vec![("number", Param::Str(n))]));
    }
    if (o.expected_season.is_none() || o.expected_episode.is_some())
        && let Some(word) = collection_pack_word(title, &index)
    {
        out.push(rej("COLLECTION_PACK", vec![("word", Param::Str(word))]));
    }
}

pub fn compute_rejections(o: &RejectionInput) -> Vec<ReleaseRejection> {
    let mut out = vec![];
    let title = o.release_title.as_deref().filter(|t| !t.is_empty());

    if let (Some(expected), Some(title)) = (o.expected_title.as_ref().filter(|e| e.truthy()), title)
    {
        title_block(o, expected, title, &mut out);
    }

    if let (Some(title), Some(year)) = (title, o.expected_year.filter(|y| *y != 0)) {
        year_block(title, year, &mut out);
    }

    if let Some(title) = title
        && (o.expected_season.is_some() || o.expected_episode.is_some())
    {
        episode_block(o, title, &mut out);
    }

    if !o.allowed.contains(&o.quality_id) {
        out.push(rej("QUALITY_NOT_ALLOWED", vec![]));
    }

    let score = o.custom_format_score.unwrap_or(0);
    if let Some(min) = o.min_custom_format_score.filter(|m| score < *m) {
        out.push(rej(
            "CUSTOM_FORMAT_SCORE_TOO_LOW",
            vec![("actual", Param::Num(score)), ("min", Param::Num(min))],
        ));
    }

    if let Some(rank) = o.rank {
        if let Some(min) = o.min_rank_exclusive.filter(|m| rank <= *m) {
            out.push(rej(
                "RANK_NOT_AN_UPGRADE",
                vec![("actual", Param::Num(rank)), ("min", Param::Num(min))],
            ));
        }
        if let Some(max) = o.max_rank_inclusive.filter(|m| rank > *m) {
            out.push(rej(
                "RANK_ABOVE_CUTOFF",
                vec![("actual", Param::Num(rank)), ("max", Param::Num(max))],
            ));
        }
    }

    if let Some(min) = o.min_resolution.filter(|m| *m > 0) {
        let res = i64::from(
            parse_release_quality(o.release_title.as_deref().unwrap_or(""))
                .quality
                .resolution,
        );
        if res <= min {
            out.push(rej(
                "RESOLUTION_NOT_UPGRADED",
                vec![("actual", Param::Num(res)), ("min", Param::Num(min))],
            ));
        }
    }

    if !o.allowed_langs.is_empty() && !o.allowed_langs.contains(&o.language_id) {
        out.push(rej("LANGUAGE_NOT_ALLOWED", vec![]));
    }
    if o.is_blocklisted {
        out.push(rej("BLOCKLISTED", vec![]));
    }

    size_block(o, &mut out);

    let min_seed = o.source_min_seeders.get(&o.source_id).copied().unwrap_or(0);
    if min_seed > 0 && o.seeders < min_seed {
        out.push(rej(
            "MIN_SEEDERS",
            vec![
                ("actual", Param::Num(o.seeders)),
                ("min", Param::Num(min_seed)),
            ],
        ));
    }
    out
}

fn year_block(title: &str, year: i64, out: &mut Vec<ReleaseRejection>) {
    let years = release_years(title);
    if !years.is_empty() && !years.iter().any(|y| (i64::from(*y) - year).abs() <= 1) {
        let actual = years
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        out.push(rej(
            "YEAR_MISMATCH",
            vec![
                ("expected", Param::Num(year)),
                ("actual", Param::Str(actual)),
            ],
        ));
    }
}

fn episode_block(o: &RejectionInput, title: &str, out: &mut Vec<ReleaseRejection>) {
    let cov = o
        .coverage
        .clone()
        .unwrap_or_else(|| release_coverage(title));
    let wrong_season =
        matches!((o.expected_season, cov.seasons), (Some(e), Some(s)) if !within(&s, e));
    let wrong_episode =
        matches!((o.expected_episode, cov.episodes), (Some(e), Some(s)) if !within(&s, e));
    let expected = format_season_episode(o.expected_season, o.expected_episode, None, None);
    if wrong_season || wrong_episode {
        out.push(rej(
            "EPISODE_MISMATCH",
            vec![
                ("expected", Param::Str(expected.clone())),
                ("actual", Param::Str(format_coverage(&cov))),
            ],
        ));
    }
    if o.expected_episode.is_some()
        && ((cov.seasons.is_some() && cov.episodes.is_none()) || cov.complete_series)
    {
        out.push(rej(
            "FULL_SEASON_FOR_EPISODE",
            vec![("expected", Param::Str(expected))],
        ));
    }
}

fn size_block(o: &RejectionInput, out: &mut Vec<ReleaseRejection>) {
    // Limits are MB/h calibrated for x264; scale them by the codec factor.
    let factor = detect_codec_size_factor(o.release_title.as_deref());
    let hours = if o.runtime_minutes > 0.0 {
        o.runtime_minutes / 60.0
    } else {
        0.0
    };
    let mb = if o.size_bytes > 0.0 {
        o.size_bytes / 1_048_576.0
    } else {
        0.0
    };
    let mb_per_hour = if hours > 0.0 { mb / hours } else { 0.0 };
    if let Some(raw) = o.size_by_quality.get(&o.quality_id)
        && mb_per_hour > 0.0
    {
        let (min, max) = (raw.min * factor, raw.max * factor);
        let actual = Param::Num(round(mb_per_hour) as i64);
        if min > 0.0 && mb_per_hour < min {
            out.push(rej(
                "SIZE_TOO_LOW",
                vec![
                    ("actual", actual.clone()),
                    ("min", Param::Num(round(min) as i64)),
                ],
            ));
        }
        if max > 0.0 && mb_per_hour > max {
            out.push(rej(
                "SIZE_TOO_HIGH",
                vec![("actual", actual), ("max", Param::Num(round(max) as i64))],
            ));
        }
    }
}
