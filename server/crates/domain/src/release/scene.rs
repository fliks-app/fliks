//! Scene to aired numbering of a series (`docs/spec/scene-numbering.md`).
use crate::release::parsing::season_episode::ParsedSeasonEpisode;
use serde::{Deserialize, Serialize};
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

impl Entry {
    fn scene(&self) -> (i64, i64) {
        (self.scene_season, self.scene_episode)
    }

    fn aired(&self) -> (i64, i64) {
        (self.season, self.episode)
    }
}

impl SceneMap {
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

    /// The aired season and episodes of a scene episode: no entry keeps the number, a scene
    /// episode mapped to consecutive episodes of one season is that range, any other split of
    /// it has no reading.
    pub fn aired(&self, season: i64, episode: i64) -> Option<(i64, i64, i64)> {
        if season == 0 {
            return Some((season, episode, episode));
        }
        let to: BTreeSet<_> = self
            .entries
            .iter()
            .filter(|e| e.scene() == (season, episode))
            .map(Entry::aired)
            .collect();
        let (Some(&(s, lo)), Some(&(_, hi))) = (to.first(), to.last()) else {
            return Some((season, episode, episode));
        };
        let one_season = to.iter().all(|(es, _)| *es == s);
        let consecutive = hi - lo + 1 == to.len() as i64;
        (one_season && consecutive).then_some((s, lo, hi))
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
            let last = p.episode_end.unwrap_or(episode);
            let mut reads = vec![];
            for n in episode..=last {
                reads.push(self.aired(season, n)?);
            }
            let (s, lo, mut hi) = reads[0];
            for (rs, _, rhi) in &reads[1..] {
                if *rs == s {
                    hi = hi.max(*rhi);
                }
            }
            return out(s, Some(lo), false, None, (hi > lo).then_some(hi));
        }
        let aired = self.aired_episodes();
        let mut covered: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        let mut unmapped = BTreeSet::new();
        for scene in season..=p.season_end.unwrap_or(season) {
            let mut seen = false;
            for e in self.entries.iter().filter(|e| e.scene_season == scene) {
                self.aired(e.scene_season, e.scene_episode)?;
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
