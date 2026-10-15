//! Genre-taste recommendations over a user's history; the queries stay with the caller.
//! `Taste::score` keeps Nest's order; the server then calls `rank_c4` (score desc, id asc, C4).
use crate::js::round;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const WINDOW: usize = 15;
const MAX_KEPT: usize = 10;
const DEFAULT_TOTAL: usize = 15;

/// A completed state's media, most recently played first (the caller takes the first 15).
#[derive(Clone, Debug, Deserialize)]
pub struct HistoryMedia {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub genres: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: i64,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub year: Option<i64>,
    pub poster_url: Option<String>,
    #[serde(default)]
    pub fanart_url: Option<String>,
    #[serde(default)]
    pub additional_fanart_urls: Option<Vec<String>>,
    #[serde(default)]
    pub genres: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct Scored {
    pub media: Candidate,
    pub score: f64,
    pub top_genre: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GenreWeight {
    pub genre: String,
    pub weight: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedMedia {
    pub id: i64,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub year: Option<i64>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
    pub genres: Vec<String>,
    pub available: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationItem {
    pub media: RecommendedMedia,
    pub because_title: String,
    pub score: f64,
}

/// Genre weights of the recently completed media (rank 0 weighs 1, rank r weighs 1/(r+1)).
pub struct Taste {
    kept: Vec<(i64, String)>,
    weights: Vec<(String, f64)>,
    source: Vec<(String, String)>,
}

fn upsert<T>(v: &mut Vec<(String, T)>, k: &str, f: impl FnOnce(Option<&T>) -> T) {
    match v.iter_mut().find(|(n, _)| n == k) {
        Some((_, x)) => *x = f(Some(x)),
        None => v.push((k.into(), f(None))),
    }
}

impl Taste {
    /// `None` when no media of the window has genres.
    pub fn from_history(window: &[Option<HistoryMedia>]) -> Option<Self> {
        let mut kept: Vec<(i64, String)> = vec![];
        let mut weights: Vec<(String, f64)> = vec![];
        let mut source: Vec<(String, String)> = vec![];
        for m in window.iter().take(WINDOW).flatten() {
            let genres = m.genres.as_deref().unwrap_or_default();
            if genres.is_empty() || kept.iter().any(|(id, _)| *id == m.id) {
                continue;
            }
            let rank = kept.len();
            kept.push((m.id, m.title.clone()));
            let w = 1.0 / (rank as f64 + 1.0);
            for g in genres {
                upsert(&mut weights, g, |x| x.map_or(0.0, |x| *x) + w);
                if rank == 0 || !source.iter().any(|(n, _)| n == g) {
                    upsert(&mut source, g, |_| m.title.clone());
                }
            }
            if kept.len() >= MAX_KEPT {
                break;
            }
        }
        (!kept.is_empty()).then_some(Self {
            kept,
            weights,
            source,
        })
    }

    /// The media the profile was built from; the caller also excludes started and dismissed ones.
    pub fn kept_ids(&self) -> impl Iterator<Item = i64> + '_ {
        self.kept.iter().map(|(id, _)| *id)
    }

    /// Most-weighted genres, raw weights.
    pub fn top_genres(&self, limit: usize) -> Vec<GenreWeight> {
        let mut all: Vec<_> = self.weights.iter().collect();
        all.sort_by(|a, b| b.1.total_cmp(&a.1));
        all.into_iter()
            .take(limit)
            .map(|(genre, weight)| GenreWeight {
                genre: genre.clone(),
                weight: *weight,
            })
            .collect()
    }

    /// Candidates with a positive match, score desc; ties keep candidate order.
    pub fn score(&self, candidates: Vec<Candidate>) -> Vec<Scored> {
        let weight = |g: &str| {
            self.weights
                .iter()
                .find(|(n, _)| n == g)
                .map_or(0.0, |(_, w)| *w)
        };
        let mut scored = vec![];
        for c in candidates {
            let genres = c.genres.as_deref().unwrap_or_default();
            if genres.is_empty() {
                continue;
            }
            let (mut total, mut top, mut top_weight) = (0.0, "", 0.0);
            for g in genres {
                let w = weight(g);
                total += w;
                if w > top_weight {
                    (top_weight, top) = (w, g);
                }
            }
            if total > 0.0 {
                let score = total / (genres.len() as f64).sqrt();
                let top_genre = top.to_owned();
                scored.push(Scored {
                    media: c,
                    score,
                    top_genre,
                });
            }
        }
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));
        scored
    }

    /// Output items of the stratified `top`; `available` holds the ids with at least one file.
    pub fn items(&self, top: Vec<Scored>, available: &HashSet<i64>) -> Vec<RecommendationItem> {
        top.into_iter()
            .map(|s| {
                let because = self.source.iter().find(|(g, _)| *g == s.top_genre);
                let m = s.media;
                RecommendationItem {
                    because_title: because
                        .map_or_else(|| self.kept[0].1.clone(), |(_, t)| t.clone()),
                    score: round(s.score * 100.0) / 100.0,
                    media: RecommendedMedia {
                        available: available.contains(&m.id),
                        id: m.id,
                        title: m.title,
                        kind: m.kind,
                        year: m.year,
                        poster_url: m.poster_url,
                        fanart_url: m.fanart_url,
                        additional_fanart_urls: m.additional_fanart_urls.unwrap_or_default(),
                        genres: m.genres.unwrap_or_default(),
                    },
                }
            })
            .collect()
    }
}

/// Deviation C4: score desc, then media id asc, instead of the database scan order.
pub fn rank_c4(scored: &mut [Scored]) {
    scored.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.media.id.cmp(&b.media.id))
    });
}

/// Caps each type at 70% of the slots (min 10) so one type cannot crowd out the other, then
/// tops up from the overflow; the result is not re-sorted.
pub fn stratify(scored: Vec<Scored>, limit: Option<usize>) -> Vec<Scored> {
    let total = limit.unwrap_or(DEFAULT_TOTAL);
    let cap = (total * 7).div_ceil(10).max(10);
    let (mut top, mut overflow) = (vec![], vec![]);
    let mut per_type: Vec<(String, usize)> = vec![];
    for s in scored {
        if top.len() >= total {
            break;
        }
        match per_type.iter_mut().find(|(t, _)| *t == s.media.kind) {
            Some((_, n)) if *n >= cap => overflow.push(s),
            Some((_, n)) => {
                *n += 1;
                top.push(s);
            }
            None => {
                per_type.push((s.media.kind.clone(), 1));
                top.push(s);
            }
        }
    }
    let room = total.saturating_sub(top.len());
    top.extend(overflow.into_iter().take(room));
    top
}
