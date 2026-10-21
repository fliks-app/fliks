# Spec: library cleanup rules

Scope: `playback_history`, `cleanup_rules`, `cleanup_candidates`, `cleanup_exclusions`, the `MediaCleanup` job, `/api/cleanup/*`, `GET /api/media/leaving-soon` and the `deleteAt` field of the media detail. Rules act at movie, series, season or episode level.

## Routes

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/cleanup/rules` | `Read Settings` | none | 200, `Rule[]` ordered by `name`, `id` | 401, 403 | none |
| `POST /api/cleanup/rules` | `Manage Settings` | `{name, enabled?, level?, criteria, action?, graceDays?, deleteSeriesWhenEmpty?, reminderDays?}` (rule 6) | 201, `Rule` | 400 field errors, 401, 403 | INSERT |
| `GET /api/cleanup/rules/{id}` | `Read Settings` | none | 200, `Rule` | 404 `Rule #<id> not found` | none |
| `PUT /api/cleanup/rules/{id}` | `Manage Settings` | as `POST`, replaces the rule | 200, `Rule` | 400, 404 | UPDATE |
| `DELETE /api/cleanup/rules/{id}` | `Manage Settings` | none | 200 | 404 | DELETE (candidates of the rule cascade) |
| `POST /api/cleanup/rules/{id}/preview` | `Manage Settings` | none | 200, `{matches: {id, title, type, size, lastPlayedAt, seasonId, episodeId, seasonNumber, episodeNumber}[], totalSize}` (`id` is the media id; the season and episode keys are null above their level) | 404 | none; also for a disabled rule |
| `GET /api/cleanup/candidates` | `Read Settings` | none | 200, `Candidate[]` ordered by `deleteAt` (nulls last), `mediaId` | 401, 403 | none |
| `POST /api/cleanup/candidates/{mediaId}/delete-now` | `Delete Media`, library ACL | query `seasonId?`, `episodeId?` (rule 26) | 200, `{ok: true}` | 404 `Media #<id> is not a cleanup candidate`, 500 | rule 22 |
| `POST /api/cleanup/exclusions/{mediaId}` | `Manage Settings`, library ACL | query `seasonId?`, `episodeId?` (rule 26) | 201, `{mediaId, seasonId, episodeId}` | 404 | INSERT exclusion (idempotent), DELETE the scope's candidates |
| `DELETE /api/cleanup/exclusions/{mediaId}` | `Manage Settings` | query `seasonId?`, `episodeId?` (rule 26) | 200 | 404 `Media #<id> is not excluded` | DELETE |
| `GET /api/media/leaving-soon` | `Read Media` | none | 200, the card shape of `recently-added` plus `deleteAt` (ISO) | 401, 403 | none |

`Rule` = `{id, createdAt, updatedAt, name, enabled, level, criteria, action, graceDays: int|null, deleteSeriesWhenEmpty, reminderDays: int[]}`. `Candidate` = `{id, mediaId, seasonId, episodeId, seasonNumber, episodeNumber, title, type, posterUrl, ruleId, ruleName, action, size, flaggedAt, deleteAt: string|null}`; the season and episode keys are null for a whole-media candidate. `size` is the sum of the scope's file sizes in bytes.

## Rules

### A. Tables

1. `cleanup_rules`: `id serial`, `createdAt`/`updatedAt timestamptz` (`updatedAt` by trigger), `name`, `enabled` (default true), `criteria jsonb`, `level` in `movie|series|season|episode` (default `movie`; the migration backfills `series` for a rule whose `criteria.mediaType` is `series`), `action` in `delete|delete_files_unmonitor|none` (default `delete`), `graceDays int >= 0` or null, `reminderDays int[]` (default `{7,1}`), `deleteSeriesWhenEmpty` boolean (default false).
2. `cleanup_candidates`: `id serial` primary key, `mediaId` (media cascade), `seasonId` and `episodeId` nullable (cascade), `ruleId` (rule cascade), `flaggedAt`, `deleteAt` nullable. Unique on `(mediaId, seasonId, episodeId)` with NULLs equal (`NULLS NOT DISTINCT`): one row per scope, one rule owns it. `lastReminderDays int` nullable: the smallest reminder threshold already sent. A whole-media row has both null, a season row only `seasonId`, an episode row both.
3. `cleanup_exclusions`: same `id`, `mediaId`, `seasonId`, `episodeId` and unique index, `userId` (`SET NULL`), `createdAt`. An exclusion protects its scope and everything below it: whole media (all levels), a season (and its episodes), an episode. Media level matching honours any exclusion of the media, season level any exclusion of the season or of one of its episodes (a protected child protects its parent).
4. Setting `cleanup_max_per_run` (`app_settings`, written by the generic settings routes): decimal string, default 10, invalid or negative falls back to 10, `0` acts on nothing.
5. `graceDays` null means no `deleteAt`: the media is flagged and never acted on. `action = none` flags (and sets `deleteAt` when `graceDays` is set, for the badge) and never acts.

6a. `playback_history` (`id serial`, `userId` users cascade, `mediaId` media cascade, `episodeId` episodes cascade or null for a movie, `playedAt timestamptz` default now), indexes on `("mediaId","playedAt")` and `("userId")`. A row is appended each time a playback state flips `completed` from false (or absent) to true: the heartbeat completion (`heartbeat.md` rule 15), `toggle-watched`, `toggle-series-watched` (each newly completed episode) and `toggle-season-watched` (each episode not completed before). A manual "mark as watched" counts as a play; marking unwatched, deleting a state or re-saving an already completed state never touches the history, and a re-watch after un-completing appends again. The migration backfills one row per completed `playback_states` row, `playedAt = COALESCE("playedAt", "lastPlayedAt", "updatedAt")`.

### B. Rule body

6. `name` trimmed, non-empty string. `enabled` boolean (default true). `level` one of rule 1, default `series` when `criteria.mediaType` is `series`, else `movie`. `action` one of rule 1 (default `delete`). `graceDays` integer 0..3650 or null/absent. `deleteSeriesWhenEmpty` boolean (default false), only `true` at season or episode level (`must be false below season level`). `reminderDays` array of at most 5 distinct integers >= 1 (null/absent: `[7,1]`, `[]`: no reminder), stored and returned sorted descending; errors `reminderDays must contain no more than 5 elements`, `each value in reminderDays must be an integer number`, `each value in reminderDays must not be less than 1`, `reminderDays's elements must be unique`. `criteria` object, required. Unknown top-level keys: `property <key> should not exist`. At `movie` and `series` level `mediaType` must agree with the level (`must be movie`/`must be series`); `level` itself adds no filter, so a `movie` rule without `mediaType` still matches series as before.
7. `criteria` keys, all optional, `null` treated as absent, combined with AND; an unknown key is `criteria.property <key> should not exist`, a wrong type is `criteria.<key> must be ...`:

    | Key | Type | Matches a media when |
    |---|---|---|
    | `libraryIds` | int[] | its library is listed |
    | `mediaType` | `movie`\|`series` | it has that type (rejected at season and episode level, which are series by nature: `is not available at season level`) |
    | `addedOlderThanDays` | int >= 0 | `media.createdAt` is older (season, episode: the newest file of the scope was added before) |
    | `releasedOlderThanDays` | int >= 0 | `media.releaseDate` is older (season: the newest `episodes.airDate` of the season; episode: its `airDate`; no date: no match) |
    | `lastPlayedOlderThanDays` | int >= 0 | the newest `playback_states.lastPlayedAt` of any user, episodes included, is older; never played matches (season: the playback states of its episodes; episode: its own) |
    | `neverPlayed` | bool | no `playback_states` row exists for it (`false` is ignored) |
    | `watchedByRequester` | bool | it has at least one requester (`requests.kind = 'add'`, user set) and every requester has watched it: a movie completed, a series with every episode on disk completed (the `exclude watched` predicate of `media-query.md` rule 20; season, episode: every episode of the scope on disk completed by every requester) |
    | `ratingBelow` | number >= 0 | `media.rating` is above 0 and below the value; a null or 0 rating is unknown and never matches (the TVDB provider stores 0) |
    | `minVotes` | int >= 1, needs `ratingBelow` | `media_metadata.voteCount` is at least the value; an unknown count fails |
    | `sizeAboveGb` | number >= 0 | the sum of its `media_files.size` exceeds the value (1 GB = 2^30 bytes; season, episode: the files of the scope) |
    | `genres` | string[] | `media.genres` holds any of them |
    | `excludeGenres` | string[] | `media.genres` holds none of them (no genres matches) |
    | `seriesEnded` | bool | it is a series with `status = 'ended'` |
    | `notLiked` | bool | no `likes` row for the media, its seasons or its episodes |
    | `playCountBelow` | int >= 1 | fewer `playback_history` rows than the value for the media (a series counts every episode play; never played is 0) |
    | `playCountByUsersBelow` | int >= 1 | fewer distinct users than the value have a `playback_history` row for the media |
    | `notPlayedInLastDays` | int >= 0 | no `playback_history` row newer than that many days (never played matches) |
    | `likedByFewerThan` | int >= 1 | fewer distinct users than the value liked the media, a season or an episode |
    | `notLikedByRequester` | bool | no requester of the media liked it (no requester matches) |
    | `keepLatestEpisodes` | int >= 1, episode level only (`is only available at episode level`) | the episode is not among the N newest episodes of its series on disk, ranked by `episodes.airDate` (no date ranks oldest), then `id` |
    | `diskFreeBelowPercent` | int 1..100 | its library path has less free space than that percentage of the disk (`libraries::disk`); a library without a readable path never matches |

    The three play-history criteria apply at movie and series level only; a season or episode rule rejects them.

    Boolean criteria constrain only when `true`. Series-scoped criteria (`libraryIds`, `ratingBelow`, `minVotes`, `genres`, `excludeGenres`, `seriesEnded`, the likes keys, `diskFreeBelowPercent`) apply to the parent series at every level.

### C. Matching

8. A rule compiles to one `SELECT` over `media` built with `QueryBuilder`; every value is bound. `diskFreeBelowPercent` is resolved per library in Rust first and bound as a library id list.
9. Every query excludes what `cleanup_exclusions` protects (rule 3). At movie and series level a rule whose action is `delete_files_unmonitor` also skips media with `monitored = false`, so a cleaned media is not flagged again. At season level the query runs over `seasons` of the series and at episode level over `episodes`, joined to `media`; a scope matches only if it has at least one file on disk, so a cleaned scope is not flagged again.
10. Each match carries `size` (bytes of the scope's files) and `lastPlayedAt` (newest play of any user in the scope, or null) for the preview, plus its season and episode ids and numbers.

### D. Job `MediaCleanup`

11. Daily `0 05 * * *`, label `system.cmd_media_cleanup`, triggerable, audited like the other core jobs (`scheduler.md`).
12. Flag phase: for the enabled rules in `id` order, collect the matches; the first rule to match a scope (media, season or episode) owns it. Candidates not matched by any enabled rule are deleted (a changed, disabled or deleted rule un-flags).
13. A newly matched scope gets a row with `deleteAt = now + graceDays` (null when `graceDays` is null). An already flagged media keeps its `flaggedAt` and `deleteAt`; only `ruleId` follows the owning rule, and a null `deleteAt` takes the new rule's value.
14. Act phase: candidates with `deleteAt <= now` whose rule action is not `none`, ordered by `deleteAt`, `id`, limited to `cleanup_max_per_run`. A failure on one media is logged and counts against the cap.
15. `delete`: `requests::services::remove_media` (the request lifecycle clears its requests), then the media folder is removed, the media lock held until then.
16. `delete_files_unmonitor`: under the media lock, `delete_media_file` (on disk) for each file, `media.monitored = false`, the candidate row is dropped.
16b. Season and episode candidates, whatever the action but `none` (`delete` included: it does not remove the series): under the media lock, `delete_media_file` (on disk) for each file of the scope, `episodes.monitored = false` for the episode (season: every episode of the season and `seasons.monitored = false`), the candidate rows of the scope are dropped. With `deleteSeriesWhenEmpty`, once the media has no file left the lock is released, then rule 15 runs (`remove_media` and folder).
17. One summary line: `MediaCleanup: <n> newly flagged, <n> cleaned, <n> failed (cap <n>)`.
18. Real media is touched only by rules 15, 16 and 16b; tests use temporary directories.

### E. Routes

19. `leaving-soon`: media with a non-null `deleteAt` on a whole-media candidate (season and episode candidates are not listed) in the viewer's accessible libraries (the `recently-added` ACL), ordered by `deleteAt`, `id`; each item is the `recently-added` card plus `deleteAt`.
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

## SQL

- Flag upsert: `INSERT INTO cleanup_candidates ("mediaId","ruleId","deleteAt") SELECT ... FROM UNNEST($1::int[],$2::int[],$3::int[]) ... ON CONFLICT ("mediaId","seasonId","episodeId") DO UPDATE SET "ruleId" = EXCLUDED."ruleId", "deleteAt" = COALESCE(cleanup_candidates."deleteAt", EXCLUDED."deleteAt") RETURNING ..., (xmax = 0)`.
- Un-flag: `DELETE FROM cleanup_candidates c WHERE NOT EXISTS (SELECT 1 FROM UNNEST($1,$2,$3) t(m,s,e) WHERE t.m = c."mediaId" AND t.s IS NOT DISTINCT FROM c."seasonId" AND t.e IS NOT DISTINCT FROM c."episodeId")`.
- Due: `... WHERE c."deleteAt" <= now() AND r.action <> 'none' ORDER BY c."deleteAt", c.id LIMIT $1`.

## Jobs/timers

| Job | Schedule (server TZ) | Setting | Behaviour | Audit row |
|---|---|---|---|---|
| `MediaCleanup` | `0 05 * * *`, manual | `cleanup_max_per_run` | rules 11-18 | `MediaCleanup`, `scheduled` / `manual` |
