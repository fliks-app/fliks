# Spec: scene numbering

A release or file name carries the numbering its group uses (scene numbering), which some series do not share with the library's (aired) numbering: a show released by part names its fourth part `S04` while the library's season 3 holds it. TheXEM publishes the per-episode mapping from scene numbering to TVDB aired numbering. Library numbering never changes.

Code: `fliks_domain::release::scene` (pure), `server/src/scene.rs` (storage, refresh, loader), callers in `plugins/acquisition/release.rs` and `ingest/library.rs`.

## Rules

1. A series has a mapping when TheXEM lists its TVDB id (`GET /map/havemap?origin=tvdb`) and its per-episode list (`GET /map/all?origin=tvdb&id=<tvdb>`) was fetched. A series without one behaves exactly as without this spec.
2. Storage: table `scene_mappings` (`tvdbId` PK, `entries` jsonb null until fetched, `fetchedAt`). Every id of `havemap` gets a row; a row is never deleted. Each entry is `{sceneSeason, sceneEpisode, season, episode}` (aired side).
3. Refresh: the `RefreshMetadata` job fetches `havemap`, then `map/all` for every library series whose tvdb external id is listed. Calls go through the shared guarded client (rate limit, circuit breaker, background priority). A failed call, a non-success body or an unparsable body keeps the stored row untouched and is logged; a series known to be mapped never falls back to identity.
4. Numbering guard: the mapping applies to a media only when every aired season above 0 of the mapping exists in the library with the same episode count as the mapping lists. Otherwise the media behaves as unmapped.
5. A scene number is translated per episode. A scene episode with no entry keeps its number (identity), so a new scene season TheXEM does not know is never extrapolated. Season 0 is never translated.
6. Release side, one place: `releases.match` (RSS, automatic search, grab assignment) and `releases.score` (interactive and automatic search ranking) translate the parsed season/episode of a release title before anything reads it. The translated coverage is the one returned and scored.
7. Translation of a parse: an episode (or episode range) maps to its aired season and episodes, keeping the range only when it stays in one aired season. A season pack covers the aired episodes its scene season maps to: when that is every aired episode of each aired season it touches, the result is a season pack (a range over several seasons); otherwise it is a partial pack, reported as one aired season with an episode range and never as a full season. A scene season with no entry is a full pack of the same number.
8. Search units (`SceneMap::scene_units`): aired season N lists the scene seasons mapping into it, an aired episode its scene episode; an aired unit with no entry searches itself. Every target the host hands a plugin (`media.acquisitionContext`, `acquisition.candidates`) carries them in `search-units` (`plugins.md` rule 31): the scene units when the mapping applies, the aired `ref` of the unit otherwise, `[]` for the whole work. A plugin queries from `search-units` only, one query per unit, and merges and deduplicates the results; matching stays in `releases.match` and `releases.score`.
9. Import: a downloaded file's parsed season and episode (and episode end) are translated for a mapped series; an explicit episode assignment of the grab wins over the file name.
10. Out of scope: labels such as `S03.Partie.4`, groups that disagree on numbering, anime absolute numbering.

## Acceptance (tests)

| Item | Test |
|---|---|
| aired S03 searches scene S04 | `aired_season_searches_its_scene_season`, `server/src/plugins/acquisition/candidates.rs` test `a_mapped_series_target_carries_the_scene_units`; plugin test `a_split_season_issues_one_query_per_scene_season` |
| scene S03 pack is aired S02, rejected for aired S03 | `scene_pack_resolves_to_the_aired_season`, `release::scoring` test `scene_pack_is_rejected_for_the_next_aired_season` |
| scene S02E01 is aired S01E06, scene S02 pack is partial aired S01 | `scene_episode_resolves_per_episode`, `split_scene_season_is_a_partial_pack` |
| file S04E01 imports into aired S03E01 | `file_numbers_translate` |
| upstream failure keeps the stored mapping | `server/src/scene.rs` test `a_failed_fetch_keeps_the_stored_mapping` |
| library not matching TVDB numbering ignores the mapping | `guard_rejects_a_library_with_other_season_counts` |
| unmapped series as before | `an_unmapped_number_keeps_its_number` |
| fixtures only, never the live service | `fixtures/scene-numbering/*.json` |
