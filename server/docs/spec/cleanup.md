# Spec: library cleanup rules

Scope: `cleanup_rules`, `cleanup_candidates`, `cleanup_exclusions`, the `MediaCleanup` job, `/api/cleanup/*`, `GET /api/media/leaving-soon` and the `deleteAt` field of the media detail. Movie and series level only. New domain: no Nest source (`[new]`).

## Routes

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/cleanup/rules` | `Read Settings` | none | 200, `Rule[]` ordered by `name`, `id` | 401, 403 | none |
| `POST /api/cleanup/rules` | `Manage Settings` | `{name, enabled?, criteria, action?, graceDays?}` (rule 6) | 201, `Rule` | 400 field errors, 401, 403 | INSERT |
| `GET /api/cleanup/rules/{id}` | `Read Settings` | none | 200, `Rule` | 404 `Rule #<id> not found` | none |
| `PUT /api/cleanup/rules/{id}` | `Manage Settings` | as `POST`, replaces the rule | 200, `Rule` | 400, 404 | UPDATE |
| `DELETE /api/cleanup/rules/{id}` | `Manage Settings` | none | 200 | 404 | DELETE (candidates of the rule cascade) |
| `POST /api/cleanup/rules/{id}/preview` | `Manage Settings` | none | 200, `{matches: {id, title, type, size, lastPlayedAt}[], totalSize}` | 404 | none; also for a disabled rule |
| `GET /api/cleanup/candidates` | `Read Settings` | none | 200, `Candidate[]` ordered by `deleteAt` (nulls last), `mediaId` | 401, 403 | none |
| `POST /api/cleanup/candidates/{mediaId}/delete-now` | `Delete Media`, library ACL | none | 200, `{ok: true}` | 404 `Media #<id> is not a cleanup candidate`, 500 | rule 22 |
| `POST /api/cleanup/exclusions/{mediaId}` | `Manage Settings`, library ACL | none | 201, `{mediaId}` | 404 | INSERT exclusion (idempotent), DELETE candidate |
| `DELETE /api/cleanup/exclusions/{mediaId}` | `Manage Settings` | none | 200 | 404 `Media #<id> is not excluded` | DELETE |
| `GET /api/media/leaving-soon` | `Read Media` | none | 200, the card shape of `recently-added` plus `deleteAt` (ISO) | 401, 403 | none |

`Rule` = `{id, createdAt, updatedAt, name, enabled, criteria, action, graceDays: int|null}`. `Candidate` = `{mediaId, title, type, posterUrl, ruleId, ruleName, action, size, flaggedAt, deleteAt: string|null}`. `size` is the sum of the media's file sizes in bytes.

## Rules

### A. Tables

1. `cleanup_rules`: `id serial`, `createdAt`/`updatedAt timestamptz` (`updatedAt` by trigger), `name`, `enabled` (default true), `criteria jsonb`, `action` in `delete|delete_files_unmonitor|none` (default `delete`), `graceDays int >= 0` or null.
2. `cleanup_candidates`: `mediaId` primary key (media cascade), `ruleId` (rule cascade), `flaggedAt`, `deleteAt` nullable. One row per media: one rule owns it.
3. `cleanup_exclusions`: `mediaId` primary key (media cascade), `userId` (`SET NULL`), `createdAt`. An excluded media is never flagged.
4. Setting `cleanup_max_per_run` (`app_settings`, written by the generic settings routes): decimal string, default 10, invalid or negative falls back to 10, `0` acts on nothing.
5. `graceDays` null means no `deleteAt`: the media is flagged and never acted on. `action = none` flags (and sets `deleteAt` when `graceDays` is set, for the badge) and never acts.

### B. Rule body

6. `name` trimmed, non-empty string. `enabled` boolean (default true). `action` one of rule 1 (default `delete`). `graceDays` integer 0..3650 or null/absent. `criteria` object, required. Unknown top-level keys: `property <key> should not exist`.
7. `criteria` keys, all optional, `null` treated as absent, combined with AND; an unknown key is `criteria.property <key> should not exist`, a wrong type is `criteria.<key> must be ...`:

    | Key | Type | Matches a media when |
    |---|---|---|
    | `libraryIds` | int[] | its library is listed |
    | `mediaType` | `movie`\|`series` | it has that type |
    | `addedOlderThanDays` | int >= 0 | `media.createdAt` is older |
    | `releasedOlderThanDays` | int >= 0 | `media.releaseDate` is older (no date: no match) |
    | `lastPlayedOlderThanDays` | int >= 0 | the newest `playback_states.lastPlayedAt` of any user, episodes included, is older; never played matches |
    | `neverPlayed` | bool | no `playback_states` row exists for it (`false` is ignored) |
    | `watchedByRequester` | bool | it has at least one requester (`requests.kind = 'add'`, user set) and every requester has watched it: a movie completed, a series with every episode on disk completed (the `exclude watched` predicate of `media-query.md` rule 20) |
    | `ratingBelow` | number >= 0 | `media.rating` is above 0 and below the value; a null or 0 rating is unknown and never matches (the TVDB provider stores 0) |
    | `minVotes` | int >= 1, needs `ratingBelow` | `media_metadata.voteCount` is at least the value; an unknown count fails |
    | `sizeAboveGb` | number >= 0 | the sum of its `media_files.size` exceeds the value (1 GB = 2^30 bytes) |
    | `genres` | string[] | `media.genres` holds any of them |
    | `excludeGenres` | string[] | `media.genres` holds none of them (no genres matches) |
    | `seriesEnded` | bool | it is a series with `status = 'ended'` |
    | `notLiked` | bool | no `likes` row for the media, its seasons or its episodes |
    | `likedByFewerThan` | int >= 1 | fewer distinct users than the value liked the media, a season or an episode |
    | `notLikedByRequester` | bool | no requester of the media liked it (no requester matches) |
    | `diskFreeBelowPercent` | int 1..100 | its library path has less free space than that percentage of the disk (`libraries::disk`); a library without a readable path never matches |

    Boolean criteria constrain only when `true`.

### C. Matching

8. A rule compiles to one `SELECT` over `media` built with `QueryBuilder`; every value is bound. `diskFreeBelowPercent` is resolved per library in Rust first and bound as a library id list.
9. Every query excludes media in `cleanup_exclusions`. A rule whose action is `delete_files_unmonitor` also skips media with `monitored = false`, so a cleaned media is not flagged again.
10. Each match carries `size` (bytes) and `lastPlayedAt` (newest play of any user, or null) for the preview.

### D. Job `MediaCleanup`

11. Daily `0 05 * * *`, label `system.cmd_media_cleanup`, triggerable, audited like the other core jobs (`scheduler.md`).
12. Flag phase: for the enabled rules in `id` order, collect the matches; the first rule to match a media owns it. Candidates not matched by any enabled rule are deleted (a changed, disabled or deleted rule un-flags).
13. A newly matched media gets a row with `deleteAt = now + graceDays` (null when `graceDays` is null). An already flagged media keeps its `flaggedAt` and `deleteAt`; only `ruleId` follows the owning rule, and a null `deleteAt` takes the new rule's value.
14. Act phase: candidates with `deleteAt <= now` whose rule action is not `none`, ordered by `deleteAt`, `mediaId`, limited to `cleanup_max_per_run`. A failure on one media is logged and counts against the cap.
15. `delete`: `requests::services::remove_media` (the request lifecycle clears its requests), then the media folder is removed, the media lock held until then.
16. `delete_files_unmonitor`: under the media lock, `delete_media_file` (on disk) for each file, `media.monitored = false`, the candidate row is dropped.
17. One summary line: `MediaCleanup: <n> newly flagged, <n> cleaned, <n> failed (cap <n>)`.
18. Real media is touched only by rules 15 and 16; tests use temporary directories.

### E. Routes

19. `leaving-soon`: media with a non-null `deleteAt` in the viewer's accessible libraries (the `recently-added` ACL), ordered by `deleteAt`, `id`; each item is the `recently-added` card plus `deleteAt`.
20. The media detail (`GET /api/media/{id}`) carries `deleteAt` (ISO) only when the media is flagged with a date; the key is absent otherwise.
21. `POST exclusions` is idempotent and removes the candidate in the same transaction.
22. `delete-now` runs the candidate's rule action at once, whatever its `deleteAt`; for a rule with action `none` it deletes the media (an explicit gesture).

### F. Events

23. `media.leaving_soon {title, mediaId, deleteAt}`: notification event sent once when a media is newly flagged with a `deleteAt`.
24. `media.cleaned_up {title, mediaId, action}`: sent after a media is cleaned (rules 15, 16, 22).
25. Both belong to the notification vocabulary (`notifications.md` rules 2, 3, 16): connections subscribe to them like any event; delivery is per connection, not per user.

## SQL

- Flag upsert: `INSERT INTO cleanup_candidates ("mediaId","ruleId","deleteAt") SELECT ... FROM UNNEST($1::int[],$2::int[],$3::int[]) ... ON CONFLICT ("mediaId") DO UPDATE SET "ruleId" = EXCLUDED."ruleId", "deleteAt" = COALESCE(cleanup_candidates."deleteAt", EXCLUDED."deleteAt") RETURNING ..., (xmax = 0)`.
- Un-flag: `DELETE FROM cleanup_candidates WHERE "mediaId" <> ALL($1)`.
- Due: `... WHERE c."deleteAt" <= now() AND r.action <> 'none' ORDER BY c."deleteAt", c."mediaId" LIMIT $1`.

## Jobs/timers

| Job | Schedule (server TZ) | Setting | Behaviour | Audit row |
|---|---|---|---|---|
| `MediaCleanup` | `0 05 * * *`, manual | `cleanup_max_per_run` | rules 11-18 | `MediaCleanup`, `scheduled` / `manual` |
