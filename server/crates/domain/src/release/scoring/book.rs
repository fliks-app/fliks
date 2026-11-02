//! Score, reject and sort audio and text search hits (`docs/spec/release.md` rules 63-64).
use super::pipeline::{Blocked, FormatScore, ReleaseCandidate};
use super::rejection::{
    ExpectedTitle, Param, RejectionInput, ReleaseRejection, compute_rejections,
};
use super::sizes::{SizeLimits, compute_size_deviation};
use super::sort::{Sortable, sort_releases_by_relevance};
use crate::books::filename::BookNameGuess;
use crate::js::round;
use crate::language::AppLanguage;
use crate::media::family::Family;
use crate::release::audio::quality::parse_audio_release;
use crate::release::parsing::language::resolve_unknown_language;
use crate::release::parsing::quality::AppQuality;
use crate::release::parsing::season_episode::Span;
use crate::release::text::quality::parse_text_release;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredBookRelease {
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
    pub retail: bool,
    pub size_deviation: Option<f64>,
    pub names: BookNameGuess,
}

impl Sortable for ScoredBookRelease {
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
        false
    }
    fn seasons(&self) -> Option<Span> {
        None
    }
    fn retail(&self) -> bool {
        self.retail
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookScoreOptions {
    pub allowed: BTreeSet<u32>,
    pub allowed_langs: BTreeSet<u32>,
    /// MB per hour for audio, MB for text.
    pub size_by_quality: BTreeMap<u32, SizeLimits>,
    pub source_min_seeders: BTreeMap<i64, i64>,
    pub source_unknown_lang: BTreeMap<i64, Option<String>>,
    /// Length of the wished audio edition; 0 when unknown.
    pub duration_minutes: f64,
    #[serde(default)]
    pub expected_title: Option<ExpectedTitle>,
    #[serde(default)]
    pub expected_year: Option<i64>,
    #[serde(default)]
    pub min_custom_format_score: Option<i64>,
    #[serde(default)]
    pub min_rank_exclusive: Option<i64>,
    #[serde(default)]
    pub max_rank_inclusive: Option<i64>,
}

struct Parsed {
    quality: &'static AppQuality,
    language: &'static AppLanguage,
    retail: bool,
    names: BookNameGuess,
}

/// `None` for a family without release parsing.
fn parse(family: Family, title: &str) -> Option<Parsed> {
    match family {
        Family::Audio => {
            let a = parse_audio_release(title);
            Some(Parsed {
                quality: a.quality,
                language: a.language,
                retail: false,
                names: a.names,
            })
        }
        Family::Text => {
            let t = parse_text_release(title);
            Some(Parsed {
                quality: t.quality,
                language: t.language,
                retail: t.retail,
                names: t.names,
            })
        }
        Family::Video | Family::Image => None,
    }
}

fn text_size_rejections(size_bytes: f64, limits: Option<&SizeLimits>) -> Vec<ReleaseRejection> {
    let (Some(l), true) = (limits, size_bytes > 0.0) else {
        return vec![];
    };
    let mb = size_bytes / 1_048_576.0;
    let actual = Param::Num(round(mb) as i64);
    let rej = |code: &str, key, v: f64| ReleaseRejection {
        code: code.to_owned(),
        params: Some(BTreeMap::from([
            ("actual", actual.clone()),
            (key, Param::Num(round(v) as i64)),
        ])),
    };
    let mut out = vec![];
    if l.min > 0.0 && mb < l.min {
        out.push(rej("SIZE_TOO_LOW", "min", l.min));
    }
    if l.max > 0.0 && mb > l.max {
        out.push(rej("SIZE_TOO_HIGH", "max", l.max));
    }
    out
}

pub fn score_and_sort_book_releases(
    family: Family,
    releases: Vec<ReleaseCandidate>,
    opts: &BookScoreOptions,
    score_custom_formats: FormatScore,
    is_blocked: Blocked,
) -> Vec<ScoredBookRelease> {
    let rows = releases
        .into_iter()
        .filter_map(|r| {
            let p = parse(family, &r.title)?;
            let unknown_iso = opts
                .source_unknown_lang
                .get(&r.source_id)
                .and_then(|i| i.as_deref());
            let lang = resolve_unknown_language(p.language, unknown_iso);
            let custom_format_score = score_custom_formats(&r.title, &r.flags);
            let blocklisted = is_blocked(&r.title, r.source_id);
            let is_audio = family == Family::Audio;
            let mut rejections = compute_rejections(&RejectionInput {
                quality_id: p.quality.id,
                allowed: opts.allowed.clone(),
                language_id: lang.id,
                allowed_langs: opts.allowed_langs.clone(),
                is_blocklisted: blocklisted,
                size_bytes: r.size,
                runtime_minutes: if is_audio { opts.duration_minutes } else { 0.0 },
                size_by_quality: opts.size_by_quality.clone(),
                seeders: r.seeders,
                source_id: r.source_id,
                source_min_seeders: opts.source_min_seeders.clone(),
                release_title: Some(r.title.clone()),
                coverage: None,
                expected_title: opts.expected_title.clone(),
                expected_season: None,
                expected_episode: None,
                min_resolution: None,
                expected_year: opts.expected_year,
                custom_format_score: Some(custom_format_score),
                min_custom_format_score: opts.min_custom_format_score,
                rank: Some(p.quality.rank.into()),
                min_rank_exclusive: opts.min_rank_exclusive,
                max_rank_inclusive: opts.max_rank_inclusive,
            });
            let limits = opts.size_by_quality.get(&p.quality.id);
            let size_deviation = if is_audio {
                compute_size_deviation(&r.title, r.size, opts.duration_minutes, limits)
            } else {
                rejections.extend(text_size_rejections(r.size, limits));
                let preferred = limits.map_or(0.0, |l| l.preferred);
                (preferred > 0.0 && r.size > 0.0)
                    .then(|| (r.size / 1_048_576.0 - preferred).abs() / preferred)
            };
            Some(ScoredBookRelease {
                quality_id: p.quality.id,
                quality_name: p.quality.name,
                rank: p.quality.rank,
                allowed: opts.allowed.contains(&p.quality.id),
                custom_format_score,
                blocklisted,
                language_id: lang.id,
                language_name: lang.name,
                language_allowed: opts.allowed_langs.is_empty()
                    || opts.allowed_langs.contains(&lang.id),
                rejections,
                retail: p.retail,
                size_deviation,
                names: p.names,
                candidate: r,
            })
        })
        .collect();
    sort_releases_by_relevance(rows, false)
}
