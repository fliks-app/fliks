//! Candidate scoring and the pure half of a search (`subtitle-scorer.ts`, `searchSubtitles`).
use crate::js::{round, rx};
use crate::language::normalize_language_code;
use crate::release::parsing::{
    attributes::parse_release_attributes, season_episode::parse_season_episode,
};
use crate::subtitle_flags::{Flags, HiMode, RequestFlags, matches_requested_flags};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_EPISODE_SCORE: u32 = 359;
pub const MAX_MOVIE_SCORE: u32 = 119;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Episode,
    Movie,
}

/// What the scorer reads from a candidate.
#[derive(Debug, Clone, Default)]
pub struct ScoreCandidate<'a> {
    pub release_name: Option<&'a str>,
    pub hash_matched: bool,
    pub imdb_id: Option<&'a str>,
    pub hearing_impaired: bool,
}

#[derive(Debug, Clone)]
pub struct ScoreContext<'a> {
    pub kind: Kind,
    pub video_release_name: Option<&'a str>,
    pub title: &'a str,
    pub year: Option<i32>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub imdb_id: Option<&'a str>,
    pub hi_mode: Option<HiMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
    pub raw: u32,
    pub max: u32,
    pub percent: u32,
    pub matches: Vec<String>,
}

fn weight(kind: Kind, name: &str) -> u32 {
    use Kind::*;
    match (kind, name) {
        (Episode, "hash") => 359,
        (Episode, "series") => 180,
        (Episode, "year") => 90,
        (Episode, "season" | "episode") => 30,
        (Episode, "releaseGroup") => 14,
        (Movie, "hash") => 119,
        (Movie, "title") => 60,
        (Movie, "year") => 30,
        (Movie, "releaseGroup") => 13,
        (Movie, "edition") => 1,
        (_, "source") => 7,
        (_, "audioCodec") => 3,
        (_, "resolution" | "videoCodec") => 2,
        (_, "hearingImpaired") => 1,
        _ => 0,
    }
}

fn norm(s: &str) -> String {
    rx!(r"[^a-z0-9]+")
        .replace_all(&s.to_lowercase(), "")
        .into_owned()
}

fn loose_title_match(haystack: &str, needle: &str) -> bool {
    let n = norm(needle);
    !n.is_empty() && norm(haystack).contains(&n)
}

fn rx_year(y: i32) -> regex::Regex {
    regex::Regex::new(&format!(r"(?-u:\b){y}(?-u:\b)")).expect("digits")
}

fn finalize(raw: u32, max: u32, matches: Vec<String>) -> Score {
    let percent = round(f64::from(raw) / f64::from(max) * 100.0).clamp(0.0, 100.0) as u32;
    Score {
        raw,
        max,
        percent,
        matches,
    }
}

pub fn score_subtitle(c: &ScoreCandidate, ctx: &ScoreContext) -> Score {
    let episode = ctx.kind == Kind::Episode;
    let max = if episode {
        MAX_EPISODE_SCORE
    } else {
        MAX_MOVIE_SCORE
    };
    if c.hash_matched {
        return finalize(max, max, vec!["hash".into()]);
    }
    let (mut raw, mut matches) = (0, Vec::<String>::new());
    let mut award = |name: &str| {
        if !matches.iter().any(|m| m == name) {
            raw += weight(ctx.kind, name);
            matches.push(name.to_owned());
        }
    };
    let strip = |s: &str| s.strip_prefix("tt").unwrap_or(s).to_owned();
    let main = if episode { "series" } else { "title" };
    let imdb = matches!((c.imdb_id, ctx.imdb_id),
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() && strip(a) == strip(b));
    let year = ctx.year.filter(|y| *y != 0);
    if imdb {
        award(main);
        if year.is_some() {
            award("year");
        }
    }
    if let (Some(rel), Some(video)) = (
        c.release_name.filter(|r| !r.is_empty()),
        ctx.video_release_name.filter(|r| !r.is_empty()),
    ) {
        let (s, v) = (
            parse_release_attributes(rel),
            parse_release_attributes(video),
        );
        let both = |a: Option<&str>, b: Option<&str>| matches!((a, b), (Some(a), Some(b)) if !a.is_empty() && a == b);
        if both(s.release_group.as_deref(), v.release_group.as_deref()) {
            award("releaseGroup");
        }
        if both(s.source, v.source) {
            award("source");
        }
        if s.resolution != 0 && s.resolution == v.resolution {
            award("resolution");
        }
        if both(s.video_codec, v.video_codec) {
            award("videoCodec");
        }
        if both(s.audio_codec, v.audio_codec) {
            award("audioCodec");
        }
        if !episode && both(s.edition, v.edition) {
            award("edition");
        }
        if loose_title_match(rel, ctx.title) {
            award(main);
        }
        if let Some(y) = year
            && rx_year(y).is_match(rel)
        {
            award("year");
        }
        if episode {
            let p = parse_season_episode(rel);
            if p.season.is_some() && p.season == ctx.season {
                award("season");
            }
            if p.episode.is_some() && p.episode == ctx.episode {
                award("episode");
            }
        }
    }
    let prefers_hi = matches!(ctx.hi_mode, Some(HiMode::Prefer | HiMode::Require));
    if c.hearing_impaired == prefers_hi {
        award("hearingImpaired");
    }
    finalize(raw, max, matches)
}

/// A provider result; also the `searchResult` a client posts back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub provider_file_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_matched: Option<bool>,
    pub language: String,
    #[serde(default)]
    pub forced: bool,
    #[serde(default)]
    pub hearing_impaired: bool,
    #[serde(default)]
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_count: Option<f64>,
    #[serde(default)]
    pub provider_name: String,
    pub provider_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Scored {
    #[serde(flatten)]
    pub candidate: Candidate,
    #[serde(rename = "_score")]
    pub score: Score,
}

#[derive(Debug, Clone, Default)]
pub struct SearchParams {
    pub imdb_id: Option<String>,
    pub title: String,
    pub year: Option<i32>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub language: String,
    pub video_release_name: Option<String>,
    pub forced: Option<bool>,
    pub hi_mode: Option<HiMode>,
}

/// Blacklist, language, flags, dedup, rescore and sort (rules 9-11).
pub fn rank_candidates(
    all: Vec<Candidate>,
    blacklist: &HashSet<String>,
    p: &SearchParams,
) -> Vec<Scored> {
    let wanted = normalize_language_code(Some(&p.language));
    let req = RequestFlags {
        forced: p.forced,
        hearing_impaired_mode: p.hi_mode,
    };
    let mut seen = HashSet::new();
    let ctx = ScoreContext {
        kind: if p.season.is_some() && p.episode.is_some() {
            Kind::Episode
        } else {
            Kind::Movie
        },
        video_release_name: p.video_release_name.as_deref(),
        title: &p.title,
        year: p.year,
        season: p.season,
        episode: p.episode,
        imdb_id: p.imdb_id.as_deref(),
        hi_mode: Some(p.hi_mode.unwrap_or(HiMode::Avoid)),
    };
    let mut scored: Vec<Scored> = all
        .into_iter()
        .filter(|r| !blacklist.contains(&format!("{}:{}", r.provider_type, r.provider_file_id)))
        .filter(|r| normalize_language_code(Some(&r.language)) == wanted)
        .filter(|r| {
            matches_requested_flags(
                Flags {
                    forced: r.forced,
                    hearing_impaired: r.hearing_impaired,
                },
                req,
            )
        })
        .filter(|r| {
            let key = match r.release_name.as_deref().filter(|n| !n.is_empty()) {
                Some(n) => format!(
                    "{}|{}|{}|{}",
                    n.to_lowercase(),
                    r.language,
                    if r.hearing_impaired { "hi" } else { "normal" },
                    if r.forced { "forced" } else { "full" }
                ),
                None => format!("{}:{}", r.provider_type, r.provider_file_id),
            };
            seen.insert(key)
        })
        .map(|mut r| {
            let s = score_subtitle(
                &ScoreCandidate {
                    release_name: r.release_name.as_deref(),
                    hash_matched: r.hash_matched.unwrap_or(false),
                    imdb_id: r.imdb_id.as_deref(),
                    hearing_impaired: r.hearing_impaired,
                },
                &ctx,
            );
            r.score = f64::from(s.percent);
            Scored {
                candidate: r,
                score: s,
            }
        })
        .collect();
    scored.sort_by(|a, b| {
        b.score.percent.cmp(&a.score.percent).then_with(|| {
            let d = |s: &Scored| s.candidate.download_count.unwrap_or(0.0);
            d(b).partial_cmp(&d(a)).unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    scored
}
