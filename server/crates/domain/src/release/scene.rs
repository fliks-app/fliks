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

impl Entry {
    fn scene(&self) -> (i64, i64) {
        (self.scene_season, self.scene_episode)
    }

    fn aired(&self) -> (i64, i64) {
        (self.season, self.episode)
    }
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
    /// `/map/all?origin=tvdb&id=<tvdb>`; an entry without `scene` or `tvdb` is skipped, and a
    /// mapping left with no entry is an error, never an identity.
    pub fn from_xem(body: &Value) -> Result<Self, String> {
        let Value::Array(rows) = data(body)? else {
            return Err("mapping data is not a list".into());
        };
        let entries: Vec<Entry> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<Pair>(r).ok())
            .map(|p| Entry {
                scene_season: p.scene.season,
                scene_episode: p.scene.episode,
                season: p.tvdb.season,
                episode: p.tvdb.episode,
            })
            .collect();
        if entries.is_empty() {
            return Err("empty mapping".into());
        }
        Ok(Self { entries })
    }

    /// Episodes per aired season, season 0 left out.
    fn aired_episodes(&self) -> BTreeMap<i64, BTreeSet<i64>> {
        let mut out: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        for e in self.entries.iter().filter(|e| e.season > 0) {
            out.entry(e.season).or_default().insert(e.episode);
        }
        out
    }

    /// Whether the library has the episode counts of the aired seasons the mapping renumbers; the
    /// last mapped season may hold more episodes than the mapping lists so far.
    pub fn fits(&self, library: &BTreeMap<i64, i64>) -> bool {
        let aired = self.aired_episodes();
        let last = aired.keys().next_back().copied();
        let renumbered: BTreeSet<i64> = self
            .entries
            .iter()
            .filter(|e| e.season > 0 && e.scene() != e.aired())
            .map(|e| e.season)
            .collect();
        renumbered.iter().all(|s| {
            let (mapped, held) = (aired[s].len() as i64, library.get(s));
            held == Some(&mapped) || (Some(*s) == last && held.is_some_and(|h| *h > mapped))
        })
    }

    /// A scene episode that two entries map to different aired episodes.
    fn ambiguous(&self, season: i64, episode: i64) -> bool {
        let to: BTreeSet<_> = self
            .entries
            .iter()
            .filter(|e| e.scene() == (season, episode))
            .map(Entry::aired)
            .collect();
        to.len() > 1
    }

    /// The aired number of a scene episode; no entry keeps the number, an ambiguous one has none.
    pub fn aired(&self, season: i64, episode: i64) -> Option<(i64, i64)> {
        if season == 0 {
            return Some((season, episode));
        }
        if self.ambiguous(season, episode) {
            return None;
        }
        let hit = self.entries.iter().find(|e| e.scene() == (season, episode));
        Some(hit.map_or((season, episode), Entry::aired))
    }

    /// The scene units to search for an aired season or episode; none known searches itself.
    pub fn scene_units(&self, season: i64, episode: Option<i64>) -> Vec<(i64, Option<i64>)> {
        if season == 0 {
            return vec![(season, episode)];
        }
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

    /// A parse of a release or file name in scene numbering, as aired numbering; none when it
    /// covers a scene number the mapping gives two aired targets.
    pub fn translate(&self, p: &ParsedSeasonEpisode) -> Option<ParsedSeasonEpisode> {
        let Some(season) = p.season.filter(|s| *s > 0) else {
            return Some(p.clone());
        };
        let out = |season, episode, full, season_end, episode_end| {
            Some(ParsedSeasonEpisode {
                season: Some(season),
                episode,
                is_full_season: full,
                season_end,
                episode_end,
                is_complete_series: p.is_complete_series,
            })
        };
        if let Some(episode) = p.episode {
            let (s, e) = self.aired(season, episode)?;
            let end = match p.episode_end {
                Some(n) => Some(self.aired(season, n)?),
                None => None,
            };
            let end = end.filter(|(es, ee)| *es == s && *ee > e).map(|(_, ee)| ee);
            return out(s, Some(e), false, None, end);
        }
        let aired = self.aired_episodes();
        let mut covered: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        let mut unmapped = BTreeSet::new();
        for scene in season..=p.season_end.unwrap_or(season) {
            let mut seen = false;
            for e in self.entries.iter().filter(|e| e.scene_season == scene) {
                if self.ambiguous(e.scene_season, e.scene_episode) {
                    return None;
                }
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
        let mut seasons: BTreeSet<i64> = covered.keys().copied().chain(unmapped).collect();
        if seasons.iter().any(|s| *s > 0) {
            seasons.remove(&0);
        }
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
