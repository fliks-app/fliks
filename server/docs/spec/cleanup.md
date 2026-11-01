# Spec: library cleanup rules

Scope: `playback_history`, `cleanup_rules`, `cleanup_candidates`, `cleanup_exclusions`, the `MediaCleanup` job, `/api/cleanup/*`, `GET /api/media/leaving-soon` and the `deleteAt` field of the media detail. Rules act at movie, series, season or episode level, one or several (rule 6).

## Routes

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/cleanup/rules` | `Read Settings` | none | 200, `Rule[]` ordered by `name`, `id` | 401, 403 | none |
| `POST /api/cleanup/rules` | `Manage Settings` | `{name, enabled?, levels?, criteria, action?, graceDays?, deleteSeriesWhenEmpty?, reminderDays?}` (rule 6) | 201, `Rule` | 400 field errors, 401, 403 | INSERT |
| `GET /api/cleanup/rules/{id}` | `Read Settings` | none | 200, `Rule` | 404 `Rule #<id> not found` | none |
| `PUT /api/cleanup/rules/{id}` | `Manage Settings` | as `POST`, replaces the rule | 200, `Rule` | 400, 404 | UPDATE |
| `DELETE /api/cleanup/rules/{id}` | `Manage Settings` | none | 200 | 404 | DELETE (candidates of the rule cascade) |
| `POST /api/cleanup/rules/{id}/preview` | `Manage Settings`, library ACL (rule 37) | none | 200, `{matches: {id, title, type, size, lastPlayedAt, seasonId, episodeId, seasonNumber, episodeNumber}[], totalSize}` (`id` is the media id; the season and episode keys are null above their level) | 404 | none; also for a disabled rule |
| `GET /api/cleanup/recommendations` | `Read Settings`, library ACL (rule 37) | none | 200, `{reasons: {key, criteria, levels}[], items: {mediaId, libraryId, title, type, size, lastPlayedAt, reasons: string[]}[]}` (rules 33-36) | 401, 403 | none |
| `GET /api/cleanup/candidates` | `Read Settings`, library ACL (rule 37) | none | 200, `Candidate[]` ordered by `deleteAt` (nulls last), `mediaId` | 401, 403 | none |
| `POST /api/cleanup/candidates/{mediaId}/delete-now` | `Delete Media`, library ACL | query `seasonId?`, `episodeId?` (rule 26) | 200, `{ok: true}` | 404 `Media #<id> is not a cleanup candidate`, 500 | rule 22 |
| `POST /api/cleanup/exclusions/{mediaId}` | `Manage Settings`, library ACL | query `seasonId?`, `episodeId?` (rule 26) | 201, `{mediaId, seasonId, episodeId}` | 404 | INSERT exclusion (idempotent), DELETE the scope's candidates |
| `DELETE /api/cleanup/exclusions/{mediaId}` | `Manage Settings` | query `seasonId?`, `episodeId?` (rule 26) | 200 | 404 `Media #<id> is not excluded` | DELETE |
| `POST /api/cleanup/candidates/bulk` | `Manage Settings` for `keep`, `Delete Media` for `delete-now`; library ACL per item | `{action: 'keep'\|'delete-now', items: {mediaId, seasonId?, episodeId?}[1..200]}` | 200, `{results: {mediaId, seasonId, episodeId, ok, error?}[]}` in request order | 400 field errors, 401, 403 | rules 21 and 22 per item |
| `GET /api/cleanup/rules/{id}/export` | `Read Settings` | none | 200, portable rule (rule 30) | 404 | none |
| `POST /api/cleanup/rules/import` | `Manage Settings` | portable rule (rule 30) | 201, `Rule` (created disabled) | 400 field errors, 401, 403 | INSERT |
| `GET /api/media/leaving-soon` | `Read Media` | none | 200, the card shape of `recently-added` plus `deleteAt` (ISO) | 401, 403 | none |

`Rule` = `{id, createdAt, updatedAt, name, enabled, levels, criteria, action, graceDays: int|null, deleteSeriesWhenEmpty, reminderDays: int[]}`. `Candidate` = `{id, mediaId, seasonId, episodeId, seasonNumber, episodeNumber, title, type, posterUrl, ruleId, ruleName, action, size, flaggedAt, deleteAt: string|null}`; the season and episode keys are null for a whole-media candidate. `size` is the sum of the scope's file sizes in bytes.

## Rules

### A. Tables

1. `cleanup_rules`: `id serial`, `createdAt`/`updatedAt timestamptz` (`updatedAt` by trigger), `name`, `enabled` (default true), `criteria jsonb`, `levels text[]`, non-empty, each in the kind names, `season` and `episode` (`movie|series|season|episode` today, widened with the kinds; the CHECK keeps a literal list; default `{movie}`; the only selector of what a rule applies to; the migration folded the former `criteria.mediaType` and the single `level` column into it), `action` in `delete|delete_files_unmonitor|none` (default `delete`), `graceDays int >= 0` or null, `reminderDays int[]` (default `{7,1}`), `deleteSeriesWhenEmpty` boolean (default false).
2. `cleanup_candidates`: `id serial` primary key, `mediaId` (media cascade), `seasonId` and `episodeId` nullable (cascade), `ruleId` (rule cascade), `flaggedAt`, `deleteAt` nullable. Unique on `(mediaId, seasonId, episodeId)` with NULLs equal (`NULLS NOT DISTINCT`): one row per scope, one rule owns it. `lastReminderDays int` nullable: the smallest reminder threshold already sent. A whole-media row has both null, a season row only `seasonId`, an episode row both.
3. `cleanup_exclusions`: same `id`, `mediaId`, `seasonId`, `episodeId` and unique index, `userId` (`SET NULL`), `createdAt`. An exclusion protects its scope and everything below it: whole media (all levels), a season (and its episodes), an episode. Media level matching honours any exclusion of the media, season level any exclusion of the season or of one of its episodes (a protected child protects its parent).
4. Setting `cleanup_max_per_run` (`app_settings`, written by the generic settings routes): decimal string, default 10, invalid or negative falls back to 10, `0` acts on nothing.
5. `graceDays` null means no `deleteAt`: the media is flagged and never acted on. `action = none` flags (and sets `deleteAt` when `graceDays` is set, for the badge) and never acts.

6a. `playback_history` (`id serial`, `userId` users cascade, `itemId` items cascade, `playedAt timestamptz` default now), indexes on `("itemId","playedAt")` and `("userId")`; a media's plays are the rows of its items. A row is appended each time a playback state flips `completed` from false (or absent) to true: the heartbeat completion (`heartbeat.md` rule 15), `toggle-watched`, `toggle-series-watched` (each newly completed episode) and `toggle-season-watched` (each episode not completed before). A manual "mark as watched" counts as a play; marking unwatched, deleting a state or re-saving an already completed state never touches the history, and a re-watch after un-completing appends again. The migration backfills one row per completed `playback_states` row, `playedAt = COALESCE("playedAt", "lastPlayedAt", "updatedAt")`.

### B. Rule body

6. `name` trimmed, non-empty string. `enabled` boolean (default true). `levels` array of rule 1 values (a whole-media level is named after its kind, so `media.type = <level>` selects it; `season` and `episode` exist only for kinds with seasons), default `["movie"]`: `levels should not be empty`, `levels must be an array`, `each value in levels must be one of the following values: movie, series, season, episode`, `levels's elements must be unique`, and at most one level of a kind with seasons or below it (`levels must hold at most one of series, season and episode`, built from the registry), so the valid sets are `[movie]`, `[series]`, `[season]`, `[episode]`, `[movie, series]`, `[movie, season]`, `[movie, episode]`; stored and returned in the order movie, series, season, episode. `action` one of rule 1 (default `delete`). `graceDays` integer 0..3650 or null/absent. `deleteSeriesWhenEmpty` boolean (default false), only `true` when `levels` holds season or episode (`must be false below season level`). `reminderDays` array of at most 5 distinct integers >= 1 (null/absent: `[7,1]`, `[]`: no reminder), stored and returned sorted descending; errors `reminderDays must contain no more than 5 elements`, `each value in reminderDays must be an integer number`, `each value in reminderDays must not be less than 1`, `reminderDays's elements must be unique`. `criteria` object, required. Unknown top-level keys: `property <key> should not exist`. `levels` is the only selector: `movie` matches movies only, `series` series only, `season` or `episode` the seasons or episodes of series; a rule is evaluated once per level and the matches are the union. A criterion must be valid for every selected level, with the messages of rule 7. A body still sending `level` gets the unknown key error. A body that still sends `criteria.mediaType` gets the error of any unknown key, `criteria.property mediaType should not exist`.
7. `criteria` keys, all optional, `null` treated as absent, combined with AND; an unknown key is `criteria.property <key> should not exist`, a wrong type is `criteria.<key> must be ...`:

    | Key | Type | Matches a media when |
    |---|---|---|
    | `libraryIds` | int[] | its library is listed |
    | `excludeLibraryIds` | int[] | its library is not listed |
    | `addedOlderThanDays` | int 0..36500 | `media.createdAt` is older (season, episode: the newest file of the scope was added before) |
    | `releasedOlderThanDays` | int 0..36500 | the media's `release` date (`media_release_dates`) is older (season: the newest `items."airDate"` of the season; episode: its `airDate`; no date: no match) |
    | `lastPlayedOlderThanDays` | int 0..36500 | the newest `playback_states.lastPlayedAt` of any user, episodes included, is older; never played matches (season: the playback states of its episodes; episode: its own) |
    | `neverPlayed` | bool | no `playback_states` row exists for it (`false` is ignored) |
    | `watchedByRequester` | bool | it has at least one requester (`requests.kind = 'add'`, user set, not declined: a declined requester was never served; pending and later states count) and every requester has watched it: a movie completed, a series with every episode on disk completed (the `exclude watched` predicate of `media-query.md` rule 20; season, episode: every episode of the scope on disk completed by every requester) |
    | `ratingBelow` | number >= 0 | `media.rating` is above 0 and below the value; a null or 0 rating is unknown and never matches (the TVDB provider stores 0) |
    | `minVotes` | int >= 1, needs `ratingBelow` | the `voteCount` of the media's details row (the details table of its kind) is at least the value; an unknown count fails |
    | `sizeAboveGb` | number >= 0 | the sum of its `media_files.size` exceeds the value (1 GB = 2^30 bytes; season, episode: the files that play an item of the scope, each counted once) |
    | `genres` | string[] | `media.genres` holds any of them |
    | `excludeGenres` | string[] | `media.genres` holds none of them (no genres matches) |
    | `seriesEnded` | bool | it is a media of a kind with seasons (`has_seasons`) with `status = 'ended'` |
    | `notLiked` | bool | no `likes` row for the media, its seasons or its episodes |
    | `playCountBelow` | int >= 1 | fewer `playback_history` rows than the value for the media (a series counts every episode play; never played is 0) |
    | `playCountByUsersBelow` | int >= 1 | fewer distinct users than the value have a `playback_history` row for the media |
    | `notPlayedInLastDays` | int 0..36500 | no `playback_history` row newer than that many days (never played matches) |
    | `likedByFewerThan` | int >= 1 | fewer distinct users than the value liked the media, a season or an episode |
    | `notLikedByRequester` | bool | no requester of the media liked it (no requester matches) |
    | `keepLatestEpisodes` | int >= 1, only when `levels` is `[episode]` (`is only available at episode level`) | the episode is not among the N newest episodes of its series on disk, ranked by `items."airDate"` (no date ranks oldest), then `id` |
    | `diskFreeBelowPercent` | int 1..100 | its library path has less free space than that percentage of the disk (`libraries::disk`); a library without a readable path never matches |

    The three play-history criteria apply at movie and series level only; a rule selecting season or episode rejects them (`is not available at <level> level`). Day criteria stop at 36500 (100 years) so the date arithmetic stays in range.

    Boolean criteria constrain only when `true`. Series-scoped criteria (`libraryIds`, `ratingBelow`, `minVotes`, `genres`, `excludeGenres`, `seriesEnded`, the likes keys, `diskFreeBelowPercent`) apply to the parent series at every level.

### C. Matching

8. A rule compiles to one `SELECT` over `media` built with `QueryBuilder`; every value is bound. `diskFreeBelowPercent` is resolved per library in Rust first and bound as a library id list.
9. Every query excludes what `cleanup_exclusions` protects (rule 3). At movie and series level (each selected level is compiled on its own) a rule whose action is `delete_files_unmonitor` also skips media with `monitored = false`, so a cleaned media is not flagged again. At season level the query runs over `seasons` of the series and at episode level over `episodes`, joined to `media`; a scope matches only if it has at least one file on disk, so a cleaned scope is not flagged again.
10. Each match carries `size` (bytes of the scope's files) and `lastPlayedAt` (newest play of any user in the scope, or null) for the preview, plus its season and episode ids and numbers.

### D. Job `MediaCleanup`

11. Daily `0 05 * * *`, label `system.cmd_media_cleanup`, triggerable, audited like the other core jobs (`scheduler.md`).
12. Flag phase: for the enabled rules in `id` order, collect the matches; the first rule to match a scope (media, season or episode) owns it. Candidates not matched by any enabled rule are deleted (a changed, disabled or deleted rule un-flags).
13. A newly matched scope gets a row with `deleteAt = now + graceDays` (null when `graceDays` is null). An already flagged media keeps its `flaggedAt` and `deleteAt`; only `ruleId` follows the owning rule, and a null `deleteAt` takes the new rule's value.
14. Act phase: candidates with `deleteAt <= now` whose rule action is not `none`, ordered by `deleteAt`, `id`, limited to `cleanup_max_per_run`. A failure on one media is logged and counts against the cap. Under the media lock each candidate is read again: one that is gone (kept, un-flagged), not yet due or whose rule is disabled or now `none` is skipped, counting neither as cleaned nor as failed. In the flag phase a rule whose query fails is logged and skipped (its candidates are un-flagged by rule 12), the other rules still run.
15. `delete`: `media::write::remove_media_with_dir` under the media lock (the request lifecycle clears its requests), then the media folder is removed, the lock held until then.
16. `delete_files_unmonitor`: under the media lock, `delete_media_file` (on disk) for each file, `setMediaMonitored([id], false)` (`media-write.md` rule 27: cascade to every season and episode, `media.monitored.changed`, then the request unmonitor hook, `requests.md` rule 38; the whole media's files are gone, so unmonitoring its children is within the rule's scope), the candidate row is dropped.
16b. Season and episode candidates, whatever the action but `none` (`delete` included: it does not remove the series): under the media lock, `delete_media_file` (on disk) for each file of the scope, `items.monitored = false` for the episode (season: every episode of the season and `setSeasonMonitored(season, false)` (`media-write.md` rule 32: episodes, `media.season.monitored.changed`, then the season hook, `requests.md` rule 39)), the candidate rows of the scope are dropped. With `deleteSeriesWhenEmpty`, once the media has no file left rule 15 runs without releasing the lock, so a file imported meanwhile is never deleted with the series.
17. One summary line: `MediaCleanup: <n> newly flagged, <n> cleaned, <n> failed (cap <n>)`.
18. Real media is touched only by rules 15, 16 and 16b; tests use temporary directories.

### E. Routes

19. `leaving-soon`: media with a non-null `deleteAt` on a whole-media candidate (season and episode candidates are not listed) in the viewer's accessible libraries (the `recently-added` ACL; each item is matched to its `deleteAt` by id, so an id that vanished meanwhile only drops out), ordered by `deleteAt`, `id`; each item is the `recently-added` card plus `deleteAt`.
20. The media detail (`GET /api/media/{id}`) carries `deleteAt` (ISO) only when the media itself is flagged with a date; the key is absent otherwise. Likewise each season and episode object of `seasons` carries `deleteAt` when its own candidate has a date.
21. `POST exclusions` is idempotent and removes the candidates it now protects in the same transaction.
22. `delete-now` runs the candidate's rule action at once, whatever its `deleteAt`; for a rule with action `none` it deletes the media (an explicit gesture), or the scope's files for a season or episode candidate.

### F. Events

23. `media.leaving_soon {title, mediaId, deleteAt, daysLeft}`: notification event, `daysLeft` = whole days to `deleteAt` rounded up, sent when a scope is newly flagged with a `deleteAt` (the first reminder) and by the reminder pass (rules 27-29); `seasonNumber` (and `episodeNumber` for an episode) join the payload when scoped.
24. `media.cleaned_up {title, mediaId, action}`: sent after a scope is cleaned (rules 15, 16, 16b, 22), with the same optional scope keys. The message appends ` S02` or ` S02E05` to the title when they are present (`notifications.md` rule 16).
25. Both belong to the notification vocabulary (`notifications.md` rules 2, 3, 16): connections subscribe to them like any event; delivery is per connection, not per user.

26. Scope of the candidate and exclusion routes: no query means the whole media; `seasonId` the season; `episodeId` the episode (its season is derived, a `seasonId` that disagrees is a 404 `Episode #<id> not found`). An unknown season or episode of the media is a 404.

27. Reminder pass, after the flag phase, for each candidate (any scope) with `deleteAt > now`: the crossed threshold is the smallest `reminderDays` value of its rule that is >= `daysLeft`. When one exists and is below `lastReminderDays` (or `lastReminderDays` is null), `media.leaving_soon` is sent once and `lastReminderDays` takes the threshold. A media flagged with fewer days left than several thresholds sends one event for the smallest of them, not one per threshold. A run between two thresholds sends nothing.
28. A newly flagged scope always sends its flag-time event (rule 23); `lastReminderDays` then takes the crossed threshold, if any, so the reminder pass does not repeat it. A candidate past its `deleteAt` gets no reminder.
29. Recipients: reminders reach the notification connections only (rule 25). The server has no per-user channel to carry them to the requesters and viewers of the media: no in-app notification store, no mobile push, no email sender. SSE (`emit_to_user`) reaches only connected clients and is not an inbox, so it is not used.

### G. Bulk and portable rules

30. Portable rule: `{fliksCleanupRule: 2, name, enabled, levels, action, graceDays, deleteSeriesWhenEmpty, reminderDays, criteria}`, with `levels`, `deleteSeriesWhenEmpty` and `reminderDays` carried as is and `criteria.libraryIds` and `criteria.excludeLibraryIds` holding library names instead of ids. Library names are unique.
31. Export emits rule 30 for the stored rule and never `criteria.mediaType`. Import accepts version 2, and version 1 (`fliksCleanupRule: 1`, files exported before `levels`): a v1 `level` becomes `levels: [level]`, a v1 legacy `criteria.mediaType` is dropped and becomes `levels` when `level` is absent, and is rejected with `criteria.mediaType contradicts level <level>` when it differs from `level`; a v1 file without either gets the default. `levels` in a v1 file and `level` in a v2 file are unknown keys. Another `fliksCleanupRule` value or a missing one is `fliksCleanupRule must be 1 or 2`; unknown top-level keys are rejected as in rule 6; a library name that does not exist is `criteria.<key> unknown library <name>`. After names are resolved to ids the body is validated exactly like `POST /api/cleanup/rules`, and the rule is created with `enabled = false` whatever the file says.
32. Bulk runs the single-item paths one after the other: `keep` is `POST exclusions`, `delete-now` is rule 22. A failing item (not found, outside the viewer's libraries, not a candidate for `delete-now`, action error) gives `ok: false` and the error text and never stops the others. Each item is `{mediaId, seasonId?, episodeId?}` with the scope of rule 26. A request without any `items`, with more than 200, or with an unknown `action` is a 400.

### H. Recommendations


33. Built-in sets, fixed in code (no table, no setting), each a reason key with criteria and levels: `never_played` `{neverPlayed: true, addedOlderThanDays: 90}`; `watched_by_requester` `{watchedByRequester: true, lastPlayedOlderThanDays: 60}`; `not_played_for_a_year` `{notPlayedInLastDays: 365, addedOlderThanDays: 365}` (movie, series); `series_ended` `{seriesEnded: true, lastPlayedOlderThanDays: 180, addedOlderThanDays: 180}` (series). The level sets are written with the kind names from the registry: every kind, and the kinds with seasons for `series_ended`. Each runs through the matching of rules 8-10 with action `delete`, so cleanup exclusions are honoured. `reasons` of the response lists the four sets, so a client can turn one into a rule.
34. A media matched by several sets appears once, with every reason in set order.
35. A media with a whole-media candidate is left out; season and episode candidates do not hide it.
36. `items` are ordered by `size` descending, then `mediaId`. The list is read-only: nothing is flagged, scheduled or deleted. Keep is `POST exclusions` (rule 21), and a deletion is `DELETE /api/media/{id}`.

37. Candidates, recommendations and rule previews list only media of the libraries the viewer may access (`libraries.md` rules 30-34, as `leaving-soon`, `delete-now` and `keep`); a media without library is never listed. A user restricted to library A sees no row of library B in any of the three.

## SQL

- Flag upsert: `INSERT INTO cleanup_candidates ("mediaId","seasonId","episodeId","ruleId","deleteAt") SELECT ... FROM UNNEST($1::int[],$2::int[],$3::int[],$4::int[],$5::int[]) ... ON CONFLICT ("mediaId","seasonId","episodeId") DO UPDATE SET "ruleId" = EXCLUDED."ruleId", "deleteAt" = COALESCE(cleanup_candidates."deleteAt", EXCLUDED."deleteAt") RETURNING ..., (xmax = 0)`.
- Un-flag: `DELETE FROM cleanup_candidates c WHERE NOT EXISTS (SELECT 1 FROM UNNEST($1,$2,$3) t(m,s,e) WHERE t.m = c."mediaId" AND t.s IS NOT DISTINCT FROM c."seasonId" AND t.e IS NOT DISTINCT FROM c."episodeId")`.
- Due: `... WHERE c."deleteAt" <= now() AND r.action <> 'none' ORDER BY c."deleteAt", c.id LIMIT $1`.

## Jobs/timers

| Job | Schedule (server TZ) | Setting | Behaviour | Audit row |
|---|---|---|---|---|
| `MediaCleanup` | `0 05 * * *`, manual | `cleanup_max_per_run` | rules 11-18 | `MediaCleanup`, `scheduled` / `manual` |
