//! Score, reject and sort a batch of search hits (`scoreAndSortReleases`).
use super::rejection::*;
use super::sizes::*;
use super::sort::{Sortable, sort_releases_by_relevance};
use crate::release::parsing::language::{parse_release_language, resolve_unknown_language};
use crate::release::parsing::quality::parse_release_quality;
use crate::release::parsing::season_episode::{ReleaseCoverage, Span, release_coverage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCandidate {
    pub title: String,
    pub download_url: String,
    pub source_id: i64,
    pub source_name: String,
    pub size: f64,
    pub seeders: i64,
    pub leechers: i64,
    pub publish_date: Option<String>,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredRelease {
    #[serde(flatten)]
    pub candidate: ReleaseCandidate,
    pub quality_id: u32,
    pub quality_name: &'static str,
    pub rank: u32,
    pub allowed: bool,
    pub custom_format_score: i64,
    pub blocklisted: bool,
    pub language_id: u32,
    pub language_name: &'static str,
    pub language_allowed: bool,
    pub rejections: Vec<ReleaseRejection>,
    pub is_full_season: bool,
    pub coverage: ReleaseCoverage,
    pub size_deviation: Option<f64>,
    pub video_codec: Option<&'static str>,
}

impl Sortable for ScoredRelease {
    fn quality_id(&self) -> i64 {
        self.quality_id.into()
    }
    fn rank(&self) -> i64 {
        self.rank.into()
    }
    fn blocklisted(&self) -> bool {
        self.blocklisted
    }
    fn language_allowed(&self) -> bool {
        self.language_allowed
    }
    fn rejected(&self) -> bool {
        !self.rejections.is_empty()
    }
    fn custom_format_score(&self) -> i64 {
        self.custom_format_score
    }
    fn seeders(&self) -> i64 {
        self.candidate.seeders
    }
    fn leechers(&self) -> i64 {
        self.candidate.leechers
    }
    fn freeleech(&self) -> bool {
        self.candidate.flags.iter().any(|f| f == "freeleech")
    }
    fn size_deviation(&self) -> Option<f64> {
        self.size_deviation
    }
    fn is_full_season(&self) -> bool {
        self.is_full_season
    }
    fn seasons(&self) -> Option<Span> {
        self.coverage.seasons
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreOptions {
    pub allowed: BTreeSet<u32>,
    pub allowed_langs: BTreeSet<u32>,
    pub size_by_quality: BTreeMap<u32, SizeLimits>,
    pub source_min_seeders: BTreeMap<i64, i64>,
    pub source_unknown_lang: BTreeMap<i64, Option<String>>,
    pub runtime_minutes: f64,
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
    pub min_custom_format_score: Option<i64>,
    #[serde(default)]
    pub min_rank_exclusive: Option<i64>,
    #[serde(default)]
    pub max_rank_inclusive: Option<i64>,
}

/// Lookups the caller precomputed (custom-format scores, blocklist).
pub trait ScorerDeps {
    fn score_custom_formats(&self, title: &str, flags: &[String]) -> i64;
    fn is_blocked(&self, title: &str, source_id: i64) -> bool;
}

pub fn score_and_sort_releases(
    releases: Vec<ReleaseCandidate>,
    opts: &ScoreOptions,
    deps: &dyn ScorerDeps,
) -> Vec<ScoredRelease> {
    let rows = releases
        .into_iter()
        .map(|r| {
            let parsed = parse_release_quality(&r.title);
            let unknown_iso = opts
                .source_unknown_lang
                .get(&r.source_id)
                .and_then(|i| i.as_deref());
            let lang = resolve_unknown_language(parse_release_language(&r.title), unknown_iso);
            let custom_format_score = deps.score_custom_formats(&r.title, &r.flags);
            let blocklisted = deps.is_blocked(&r.title, r.source_id);
            let coverage = release_coverage(&r.title);
            let quality = parsed.quality;
            let rejections = compute_rejections(&RejectionInput {
                quality_id: quality.id,
                allowed: opts.allowed.clone(),
                language_id: lang.id,
                allowed_langs: opts.allowed_langs.clone(),
                is_blocklisted: blocklisted,
                size_bytes: r.size,
                runtime_minutes: opts.runtime_minutes,
                size_by_quality: opts.size_by_quality.clone(),
                seeders: r.seeders,
                source_id: r.source_id,
                source_min_seeders: opts.source_min_seeders.clone(),
                release_title: Some(r.title.clone()),
                coverage: Some(coverage.clone()),
                expected_title: opts.expected_title.clone(),
                expected_season: opts.expected_season,
                expected_episode: opts.expected_episode,
                min_resolution: opts.min_resolution,
                expected_year: opts.expected_year,
                custom_format_score: Some(custom_format_score),
                min_custom_format_score: opts.min_custom_format_score,
                rank: Some(quality.rank.into()),
                min_rank_exclusive: opts.min_rank_exclusive,
                max_rank_inclusive: opts.max_rank_inclusive,
            });
            ScoredRelease {
                quality_id: quality.id,
                quality_name: quality.name,
                rank: quality.rank,
                allowed: opts.allowed.contains(&quality.id),
                custom_format_score,
                blocklisted,
                language_id: lang.id,
                language_name: lang.name,
                language_allowed: opts.allowed_langs.is_empty()
                    || opts.allowed_langs.contains(&lang.id),
                rejections,
                is_full_season: coverage.seasons.is_some() && coverage.episodes.is_none(),
                size_deviation: compute_size_deviation(
                    &r.title,
                    r.size,
                    opts.runtime_minutes,
                    opts.size_by_quality.get(&quality.id),
                ),
                video_codec: detect_video_codec(Some(&r.title)),
                coverage,
                candidate: r,
            }
        })
        .collect();
    sort_releases_by_relevance(
        rows,
        opts.expected_season.is_some() && opts.expected_episode.is_none(),
    )
}
