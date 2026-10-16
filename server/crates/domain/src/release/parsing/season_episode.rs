//! Season and episode of a release title (`season-episode.parser.ts`); patterns are ASCII-only like JS without `u`.
use crate::js::rx;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSeasonEpisode {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_full_season: bool,
    pub season_end: Option<i64>,
    pub episode_end: Option<i64>,
    pub is_complete_series: bool,
}

/// Inclusive range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCoverage {
    pub seasons: Option<Span>,
    pub episodes: Option<Span>,
    pub complete_series: bool,
}

pub fn within(range: &Span, n: i64) -> bool {
    n >= range.from && n <= range.to
}

fn num(s: &str) -> i64 {
    s.parse().expect("1-3 ASCII digits")
}

fn digit_runs(s: &str) -> Vec<i64> {
    s.split(|c: char| !c.is_ascii_digit())
        .filter(|r| !r.is_empty())
        .map(num)
        .collect()
}

fn up_to(from: i64, to: Option<i64>) -> Option<i64> {
    to.filter(|t| *t > from)
}

fn complete_series(title: &str) -> bool {
    rx!(i r"\b(?:Complete[\s._-]*Series|Int[eEéÉ]grale)\b").is_match(title)
}

pub fn parse_season_episode(title: &str) -> ParsedSeasonEpisode {
    let result = |season, episode, is_full_season, season_end, episode_end| ParsedSeasonEpisode {
        season,
        episode,
        is_full_season,
        season_end,
        episode_end,
        is_complete_series: season.is_none() && complete_series(title),
    };
    let pack = |m: Option<regex::Captures>| {
        let m = m?;
        let from = num(&m[1]);
        let to = up_to(from, m.get(2).or(m.get(3)).map(|g| num(g.as_str())))?;
        Some(result(Some(from), None, true, Some(to), None))
    };

    if let Some(m) =
        rx!(i r"\bS(\d{1,2})E(\d{1,3})(?:((?:-?E\d{1,3})+)|-(\d{1,3}))?\b").captures(title)
    {
        let episode = num(&m[2]);
        let last = m
            .get(3)
            .and_then(|g| digit_runs(g.as_str()).pop())
            .or_else(|| m.get(4).map(|g| num(g.as_str())));
        return result(
            Some(num(&m[1])),
            Some(episode),
            false,
            None,
            up_to(episode, last),
        );
    }
    if let Ok(Some(m)) =
        rx!(fancy i r"(?<![a-zA-Z\d])(\d{1,2})x(?!26[45]\b)(\d{1,3})(?:-(\d{1,3}))?\b")
            .captures(title)
    {
        let episode = num(&m[2]);
        let end = m.get(3).map(|g| num(g.as_str()));
        return result(
            Some(num(&m[1])),
            Some(episode),
            false,
            None,
            up_to(episode, end),
        );
    }
    let range = pack(
        rx!(i r"\bS(\d{1,2})(?:-(\d{1,2})|[\s._]*(?:-|to|a|[àÀ])[\s._]*S(\d{1,2}))\b")
            .captures(title),
    )
    .or_else(|| {
        pack(
            rx!(i r"\b(?:Seasons?|Saisons?)[\s._-]?(\d{1,2})(?:-(\d{1,2})|[\s._]+(?:to|a|[àÀ])[\s._]+S?(\d{1,2}))\b")
                .captures(title),
        )
    });
    if let Some(range) = range {
        return range;
    }
    if let Some(m) = rx!(i r"\bS(\d{1,2})((?:[\s._+&,-]+S\d{1,2})+)\b").captures(title) {
        let nums: Vec<i64> = std::iter::once(num(&m[1]))
            .chain(digit_runs(&m[2]))
            .collect();
        if nums.windows(2).all(|w| w[1] == w[0] + 1) {
            return result(Some(nums[0]), None, true, nums.last().copied(), None);
        }
    }
    if let Ok(Some(m)) = rx!(fancy i
        r"\b(?:S|Seasons?[\s._]?|Saisons?[\s._]?)(\d{1,2})[\s._]+-[\s._]+(\d{1,3})(?![.,]\d)(?:-(\d{1,3}))?\b")
    .captures(title)
    {
        let episode = num(&m[2]);
        let end = m.get(3).map(|g| num(g.as_str()));
        return result(Some(num(&m[1])), Some(episode), false, None, up_to(episode, end));
    }
    if let Ok(Some(m)) = rx!(fancy i r"\bS(\d{1,2})(?!E\d)\b").captures(title) {
        return result(Some(num(&m[1])), None, true, None, None);
    }
    if let Some(m) = rx!(i r"\b(?:Seasons?|Saisons?)[\s._-]?(\d{1,2})\b").captures(title) {
        return result(Some(num(&m[1])), None, true, None, None);
    }
    result(None, None, false, None, None)
}

pub fn coverage_of(p: &ParsedSeasonEpisode) -> ReleaseCoverage {
    ReleaseCoverage {
        seasons: p.season.map(|s| Span {
            from: s,
            to: p.season_end.unwrap_or(s),
        }),
        episodes: p.episode.map(|e| Span {
            from: e,
            to: p.episode_end.unwrap_or(e),
        }),
        complete_series: p.is_complete_series,
    }
}

pub fn release_coverage(title: &str) -> ReleaseCoverage {
    coverage_of(&parse_season_episode(title))
}
