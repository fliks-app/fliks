//! Scene to aired numbering of a series (`docs/spec/scene-numbering.md`).
use crate::release::parsing::season_episode::ParsedSeasonEpisode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub scene_season: i64,
    pub scene_episode: i64,
    pub season: i64,
    pub episode: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SceneMap {
    pub entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Side {
    season: i64,
    episode: i64,
}

#[derive(Deserialize)]
struct Pair {
    scene: Side,
    tvdb: Side,
}

fn data(v: &Value) -> Result<Value, String> {
    match v.get("result").and_then(Value::as_str) {
        Some("success") => Ok(v.get("data").cloned().unwrap_or(Value::Null)),
        _ => Err("TheXEM did not answer success".into()),
    }
}

/// The TVDB ids TheXEM maps (`/map/havemap?origin=tvdb`).
pub fn parse_havemap(body: &Value) -> Result<BTreeSet<i64>, String> {
    let Value::Array(ids) = data(body)? else {
        return Err("havemap data is not a list".into());
    };
    ids.iter()
        .map(|v| match v {
            Value::String(s) => s.parse().ok(),
            n => n.as_i64(),
        })
        .collect::<Option<_>>()
        .ok_or_else(|| "havemap holds a non-numeric id".into())
}

impl SceneMap {
    /// `/map/all?origin=tvdb&id=<tvdb>`; an empty mapping is an error, never an identity.
    pub fn from_xem(body: &Value) -> Result<Self, String> {
        let pairs: Vec<Pair> = serde_json::from_value(data(body)?).map_err(|e| e.to_string())?;
        if pairs.is_empty() {
            return Err("empty mapping".into());
        }
        let entries = pairs
            .into_iter()
            .map(|p| Entry {
                scene_season: p.scene.season,
                scene_episode: p.scene.episode,
                season: p.tvdb.season,
                episode: p.tvdb.episode,
            })
            .collect();
        Ok(Self { entries })
    }

    /// Episode counts per aired season, season 0 left out.
    fn aired_episodes(&self) -> BTreeMap<i64, BTreeSet<i64>> {
        let mut out: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        for e in self.entries.iter().filter(|e| e.season > 0) {
            out.entry(e.season).or_default().insert(e.episode);
        }
        out
    }

    /// Whether the library's episode count per season is the numbering the mapping targets.
    pub fn fits(&self, library: &BTreeMap<i64, i64>) -> bool {
        self.aired_episodes()
            .iter()
            .all(|(s, eps)| library.get(s) == Some(&(eps.len() as i64)))
    }

    /// The aired number of a scene episode; no entry keeps the number.
    pub fn aired(&self, season: i64, episode: i64) -> (i64, i64) {
        if season == 0 {
            return (season, episode);
        }
        self.entries
            .iter()
            .find(|e| e.scene_season == season && e.scene_episode == episode)
            .map_or((season, episode), |e| (e.season, e.episode))
    }

    /// The scene units to search for an aired season or episode; none known searches itself.
    pub fn scene_units(&self, season: i64, episode: Option<i64>) -> Vec<(i64, Option<i64>)> {
        let hits = self
            .entries
            .iter()
            .filter(|e| e.season == season && episode.is_none_or(|n| e.episode == n));
        let units: BTreeSet<_> = hits
            .map(|e| (e.scene_season, episode.map(|_| e.scene_episode)))
            .collect();
        if units.is_empty() {
            vec![(season, episode)]
        } else {
            units.into_iter().collect()
        }
    }

    /// A parse of a release or file name in scene numbering, as aired numbering.
    pub fn translate(&self, p: &ParsedSeasonEpisode) -> ParsedSeasonEpisode {
        let Some(season) = p.season.filter(|s| *s > 0) else {
            return p.clone();
        };
        let out = |season, episode, full, season_end, episode_end| ParsedSeasonEpisode {
            season: Some(season),
            episode,
            is_full_season: full,
            season_end,
            episode_end,
            is_complete_series: p.is_complete_series,
        };
        if let Some(episode) = p.episode {
            let (s, e) = self.aired(season, episode);
            let end = p
                .episode_end
                .map(|n| self.aired(season, n))
                .filter(|(es, ee)| *es == s && *ee > e)
                .map(|(_, ee)| ee);
            return out(s, Some(e), false, None, end);
        }
        let aired = self.aired_episodes();
        let mut covered: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        let mut unmapped = BTreeSet::new();
        for scene in season..=p.season_end.unwrap_or(season) {
            let mut seen = false;
            for e in self.entries.iter().filter(|e| e.scene_season == scene) {
                covered.entry(e.season).or_default().insert(e.episode);
                seen = true;
            }
            if !seen {
                unmapped.insert(scene);
            }
        }
        let partial = covered
            .iter()
            .find(|(s, eps)| aired.get(s).is_some_and(|all| !all.is_subset(eps)));
        if let Some((s, eps)) = partial {
            let (lo, hi) = (eps.first().copied(), eps.last().copied());
            return out(*s, lo, false, None, hi.filter(|h| Some(*h) > lo));
        }
        let seasons: BTreeSet<i64> = covered.keys().copied().chain(unmapped).collect();
        let (lo, hi) = (seasons.first().copied(), seasons.last().copied());
        out(
            lo.unwrap_or(season),
            None,
            true,
            hi.filter(|h| Some(*h) > lo),
            None,
        )
    }
}
