# Spec: playback state, history, continue watching, recommendations, watched toggles

Scope: 16 of the 18 routes of `PlaybackController`. `PUT media/:mediaId/state` is `heartbeat.md` (including `PlaybackService.updateState` and the auto-playlist rule); `POST sessions/:sessionId/events` is `qoe.md`.

## Routes

Class-level on `PlaybackController`: `@Controller('playback')`, `@UseGuards(JwtOrApiKeyGuard)`. No `PoliciesGuard`, no policies, **no `SessionTokenGuard`** on any route below (a stream/cast scoped token can read and toggle). `:mediaId` and `:seasonId` use `ParseIntPipe` (400 `Validation failed (numeric string is expected)`). Bodies are inline types (no DTO class, no validation). Every user is the authenticated one (`req.user`); there is no cross-user access. All success codes are 200 unless stated; a handler returning `void`/`null`/`undefined` answers **200 with an empty body**, not JSON `null`.

Library scoping everywhere: `getAccessibleLibraryIds(user)` (libraries spec) is a concrete `number[]`; `[]` short-circuits to an empty result before any SQL.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/playback/recommendations` | `JwtOrApiKeyGuard` (class); policies none | query `libraryId?`, `limit?` (rule 1) | `RecommendationItem[]` (rule 28) | 401 | none |
| `POST /api/playback/recommendations/:mediaId/dismiss` | `JwtOrApiKeyGuard` (class); policies none | path | 204, no body | 400 pipe | insert dismissal (idempotent) |
| `GET /api/playback/recommendations/dismissed/count` | `JwtOrApiKeyGuard` (class); policies none | - | `{ count: number }` | - | none |
| `DELETE /api/playback/recommendations/dismissed` | `JwtOrApiKeyGuard` (class); policies none | - | `{ removed: number }` | - | deletes all the user's dismissals |
| `GET /api/playback/watched-ids` | `JwtOrApiKeyGuard` (class); policies none | - | `number[]` | - | none |
| `GET /api/playback/continue-watching` | `JwtOrApiKeyGuard` (class); policies none | query `libraryId?` | `ContinueWatchingItem[]` (max 20) | - | none |
| `GET /api/playback/history` | `JwtOrApiKeyGuard` (class); policies none | query `page?`, `limit?` | `{ data: WatchHistoryItem[], total: number }` | - | none |
| `GET /api/playback/media/:mediaId/watched-episodes` | `JwtOrApiKeyGuard` (class); policies none | path | `number[]` (episode ids) | 400 pipe | none |
| `GET /api/playback/media/:mediaId/episode-progress` | `JwtOrApiKeyGuard` (class); policies none | path | `{ [episodeId]: number }` (percent 1..99) | 400 pipe | none |
| `GET /api/playback/media/:mediaId` | `JwtOrApiKeyGuard` (class); policies none | path | `MediaResumeInfo` or empty body | 400 pipe | none |
| `GET /api/playback/media/:mediaId/state` | `JwtOrApiKeyGuard` (class); policies none | path; query `episodeId?` | `PlaybackState` entity or empty body | 400 pipe | none |
| `DELETE /api/playback/media/:mediaId/state` | `JwtOrApiKeyGuard` (class); policies none | path; query `episodeId?` | 200 empty | 400 pipe | deletes the row if present |
| `DELETE /api/playback/hide/:mediaId` | `JwtOrApiKeyGuard` (class); policies none | path | 200 empty | 400 pipe | hides every row of that media |
| `POST /api/playback/media/:mediaId/toggle-watched` | `JwtOrApiKeyGuard` (class); policies none | body `{ mediaFileId?:number, episodeId?:number }` | `PlaybackState` entity (saved) | 400 pipe; 500 on DB error | upsert row; playlist auto-remove when it becomes watched |
| `POST /api/playback/media/:mediaId/toggle-series-watched` | `JwtOrApiKeyGuard` (class); policies none | body `{ watched:boolean }` | `{ watched: boolean }` | 400 pipe | bulk upsert/update; playlist auto-remove when watched |
| `POST /api/playback/media/:mediaId/seasons/:seasonId/toggle-watched` | `JwtOrApiKeyGuard` (class); policies none | body `{ watched:boolean }` | `{ watched: boolean }` | 400 pipe | delete+insert / update; playlist auto-remove when watched |

`PlaybackState` JSON (entity, no `@Exclude`): `id, createdAt, updatedAt, positionSeconds, durationSeconds (nullable), completed, hiddenFromContinueWatching, lastPlayedAt, playedAt (nullable)`, and for a row **loaded** from the DB `userId, mediaId, mediaFileId, episodeId`: `mediaId` is the media of the row's item, `episodeId` the item's id when it is in a group and `null` for a movie's item, `mediaFileId` the last file played (`null` once that file is deleted); a row **just inserted** carries `user:{id}, media:{id}, mediaFile:{id}|absent, episode:{id}|null` instead (see `heartbeat.md` rule 16). `GET.../state` always has the former shape.

## Rules

### Library-scoped queries

1. `recommendations`: `libraryId = parseInt(libraryIdRaw,10)` when the query value is non-empty; if truthy and finite (`0`/`NaN` are ignored), the scope is `[libraryId]` when it is in the accessible list, else `[]` (silent empty result, not 403); otherwise all accessible ids. `limit` absent -> `undefined` (service default 15); present -> `min(50, max(1, parseInt(limit,10) || 15))` (`0` and non-numeric become 15).
2. `continue-watching`: same `libraryId` rule as 1.
3. `history`: `page = max(1, Number(page) || 1)`, `limit = min(100, max(1, Number(limit) || 25))` (`Number`, not `parseInt`: `page=2.5` gives a fractional `OFFSET` that Postgres rejects -> 500; `limit=2.5` likewise is bound as a non-integer). Scope = all accessible ids.
4. `watched-ids`: scope = all accessible ids.

### State reads and deletes

5. A state belongs to one item: `(userId, itemId)` is unique (`items.md`). The wire names `(mediaId, episodeId?)`, and `item_of(media, episode)` (SQL below) resolves it: an absent episode names the media's ungrouped item (a movie's) when the media has exactly one, an episode id names that item when it belongs to `mediaId`. A media with several ungrouped items names none for an absent episode, and the routes that take the pair answer `409 ambiguous_item` instead (`GET`/`DELETE state`, `toggle-watched`, the heartbeat). Any other pair (a series without episode, an unknown media, an episode of another media) names no item: `GET state` answers an empty body, `DELETE state` is a no-op, `toggle-watched` is 404 `not_found` and the heartbeat answers `{state: null}`. The controller parses `episodeId` with `parseInt` only when the query value is non-empty; `NaN` and `0` are falsy and select the **movie item**.
6. `GET state`: returns the row of `(user, item)` or `null` (empty body). `DELETE state`: removes that row, no error when absent, 200 empty.
7. `GET media/:id` (resume info): newest not-completed row of the user for any item of that media with `positionSeconds > 0`, joined to its group/item numbers; `null` -> empty body; `positionSeconds` is `0` when the stored value is `< 10` (`RESUME_FROM_START_UNDER_SECONDS`), else as stored; `durationSeconds` `Number()`-ed; `seasonNumber`/`episodeNumber` omitted (undefined) when null (movies). `mediaFileId` is the last file played when it is still a part of the item, else the first part (lowest position) of the version the state names, else of the item's highest version, `null` when the item has none (`items.md` rule 35).
8. `watched-episodes`: distinct ids of the media's grouped items the user completed; no ordering.
9. `episode-progress`: object keyed by episode id (a grouped item's id) with `ROUND(position/duration*100)` for not-completed rows with duration and position `> 0`; only values with `0 < p < 100` are kept (a row at 100 or rounding to 0 is dropped). JSON keys are decimal strings.
10. `hide/:mediaId`: `hiddenFromContinueWatching = true` on **every** row of the user's states of the media's items (movie item and episodes); the flag is cleared again by the next heartbeat write (`heartbeat.md` rule 15).

### Continue watching

11. One statement (SQL below), per media, then ordered and cut in SQL. Movies (ungrouped items): not completed, not hidden, `positionSeconds >= 5` (`HISTORY_MIN_WATCH_SECONDS`), scoped by library; `episodeLabel = null`. Series ("next up"): per media the in-progress item (latest `lastPlayedAt`, not completed, `positionSeconds >= 5`, hidden or not) else the item after the highest completed `(group number, item number)` (groups numbered `> 0`) when it exists and has a part and is not completed; `episodeLabel = 'S' || LPAD(season,2,'0') || 'E' || LPAD(ep,2,'0') || COALESCE(' - ' || title,'')`; `id = 0` when there is no state row for the next item; `lastPlayedAt` = the series' most recent non-hidden state. `mediaType` of every row is the media's kind (`media.type`), never derived from whether the item is grouped. `mediaFileId` is the last file played when it is a part of the item, else the first part of the version the state names, else of the item's highest version; a row whose item has no part is dropped, movies included (a client cannot play it). Post-processing per row: `positionSeconds` and `progressPercent` are set to `0` when `positionSeconds < 10` (the item stays listed). Order: `lastPlayedAt` truncated to the millisecond DESC, then the media's kind name (movie before series), then media id; `LIMIT 20`.
12. `ContinueWatchingItem` fields: `id, mediaId, mediaFileId (number|null), episodeId (number|null), positionSeconds, durationSeconds, progressPercent, lastPlayedAt, mediaTitle, mediaType, posterUrl, fanartUrl, stillUrl, episodeLabel`; movies have `stillUrl: null`.

### History

13. `history`: rows with `"playedAt" IS NOT NULL` (set by real playback progress only: manual "mark watched" never sets it) for accessible libraries, newest `playedAt` first, `LIMIT $limit OFFSET (page-1)*limit`; `total` = count of the same predicate (as a `Number`). `progressPercent` `Number()`-ed. Empty accessible list -> `{data:[], total:0}`. `WatchHistoryItem` = `id, mediaId, mediaFileId, episodeId, positionSeconds, durationSeconds, progressPercent, completed, lastPlayedAt, mediaTitle, mediaType, posterUrl, fanartUrl, stillUrl, episodeLabel (null for movies)`.
14. `watched-ids`: ids of movies completed by the user plus series whose every non-special episode that has a file (an item part, `items.md` rule 21, `seasonNumber > 0`) is completed (at least one such episode); union, `DISTINCT` semantics, no ordering; `[]` when no library.

### Watched toggles

15. `toggle-watched` (`toggleWatched`): `item = item_of(media, body.episodeId)`, none -> 404 `not_found`; `existing` = the row of `(user, item)`; `willBeCompleted = existing ? !existing.completed: true`. For a new row with no `body.mediaFileId`, the first part of the item's highest version is the file; no part leaves `mediaFileId` **NULL** (the column is nullable). Then `completed = willBeCompleted`; `lastPlayedAt = now`; `mediaFile = {id: fileId}` only when a file id is known; when completing: `positionSeconds = 0`, and if `durationSeconds` is falsy it is read from `media_files."streamInfo"->durationSeconds` of `fileId || state.mediaFileId` (else `0`; no read when neither id exists); un-completing leaves position and duration. `playedAt` is never set or cleared. When `willBeCompleted`, one `playback_history` row and `removeWatchedFromAutoPlaylists(user, media, episodeId != null ? [episodeId]: null)` through the isolated wrapper (`heartbeat.md` rules 19-20). Returns the saved row (new-row shape for an insert, loaded-row shape for an update). Ownership of `mediaFileId` is not checked: an unknown file is an FK violation, answered 404 `not_found`.
16. `toggle-series-watched` (`toggleSeriesWatched(userId, mediaId, !!body.watched)`): watched: one raw upsert (SQL below) for every item with a part in groups with `number > 0` of `mediaId`: file = the first part of the item's highest version, `positionSeconds = 0`, `durationSeconds` = that file's `streamInfo->>'durationSeconds'` as float (0 if missing), `completed = true`, `lastPlayedAt = NOW()`; on conflict `("userId","itemId")`: only `completed = true`, `positionSeconds = 0`, `lastPlayedAt = NOW()` (duration, file and `playedAt` untouched; new rows have `playedAt` NULL). Then loads **all** completed states of the user for the media's grouped items (including ones this call did not touch), maps them to item ids and calls the playlist auto-remove with that list (an empty list returns early inside the playlist method). Unwatched: `UPDATE` every state of the media's grouped items (specials and file-less items included) to `completed = false, positionSeconds = 0, lastPlayedAt = NOW()`. Returns `{watched}`. Not transactional.
17. `toggle-season-watched` (`toggleSeasonWatched(userId, mediaId, seasonId, !!body.watched)`): the route answers 404 for an unknown media and for a season of another media; a season with no items writes nothing. Both directions act on the season's items. Watched: only items with a part; none -> `{watched}`; latest file per item through its parts (the first part of its highest version); one upsert on `(userId, itemId)` writes a row per item that has a file: `mediaFileId`, `positionSeconds = 0`, `durationSeconds = file.streamInfo?.durationSeconds ?? 0`, `completed = true`, `hiddenFromContinueWatching = false`, `lastPlayedAt = now`; `playedAt` is null on a new row and kept on an existing one; when at least one row was written call the playlist auto-remove with those item ids. Unwatched: `UPDATE... SET completed = false, "positionSeconds" = 0, "lastPlayedAt" = now` on the user's rows of all the season's items. Returns `{watched}`.
18. The season and series-wide upserts keep any previous `playedAt` of those rows, so the history entries of the episodes stay when a season is marked watched.

18a. Every flip of `completed` to true in rules 15-17 and in the heartbeat appends a `playback_history` row (`cleanup.md` rule 6a); un-completing deletes nothing.

### Recommendations

19. `dismiss(userId, mediaId)`: `INSERT INTO recommendation_dismissals ("userId","mediaId") VALUES ($1,$2) ON CONFLICT DO NOTHING` (`orIgnore`), idempotent on unique `UQ_recommendation_dismissals_user_media (userId, mediaId)`; no check that the media exists or is accessible; 204.
20. `resetDismissals`: `DELETE... WHERE "userId" = $1`, answer `{removed: affected ?? 0}`. `countDismissals`: `SELECT COUNT(*)... WHERE "userId" = $1` -> `{count}`.
21. `getRecommendations(userId, libs, limit?)`: `libs` empty -> `[]`. **History window**: the user's 15 most recent `completed = true` states (`lastPlayedAt` DESC, joined through their item to its media); walk them in order; skip a state whose media is missing or has no genres (it still used one of the 15); skip a media id already taken; keep at most 10 unique media, assigning `rank` 0,1,2... only to kept ones; none kept -> `[]`.
22. **Genre profile**: for each kept media with `rank r`, `weight = 1/(r+1)` is added to each of its genres (a genre repeated in one media counts each time); `genreSource[g]` = title of the media that first contributed `g`, replaced by the rank-0 media whenever it contributes `g`.
23. **Exclusions**: the kept media ids, **every** media id the user has any `playback_states` row for through one of its items (completed or not), and every dismissed media id.
24. **Candidates**: media with `genres IS NOT NULL AND genres != '[]'`, `id NOT IN (excluded)` (clause omitted when the set is empty), `"libraryId" IN (libs)`; columns `id, title, type, year, posterUrl, fanartUrl, additionalFanartUrls, genres`; **no `ORDER BY`**.
25. **Score** per candidate with genres: `total = sum(genreWeights[g] ?? 0)`; `topGenre` = the first genre (candidate order) with the strictly greatest weight; candidates with `total <= 0` are dropped; `score = total / sqrt(candidate.genres.length)`. Stable sort by score DESC (ties keep candidate/DB order).
26. **Stratification**: `TOTAL = limit ?? 15`; `PER_TYPE_CAP = max(10, ceil(TOTAL * 0.7))`; walk `scored`: stop at `TOTAL`; an item whose type already has `PER_TYPE_CAP` items goes to `overflow`, else to `top` and counts for its type; afterwards append `overflow` in order until `TOTAL`. The result is **not** re-sorted after the append.
27. **Availability**: one query for the `top` ids marks `available = true` when the media has at least one `media_files` row directly (movie) or via `episodes -> seasons` (series) (SQL below).
28. **Output item**: `{ media: { id, title, type, year, posterUrl, fanartUrl: m.fanartUrl ?? null, additionalFanartUrls: m.additionalFanartUrls ?? [], genres, available }, becauseTitle: genreSource.get(topGenre) ?? recentMedia[0].media.title, score: Math.round(score * 100) / 100 }`; `year` and `posterUrl` are passed through (JSON `null` when null).
29. `getTopGenres(userId, limit = 8)` (no route here; used by the social profile): same 15-state window, skip/dedup and weights as rules 21-22 (stops after 10 kept media); returns `[{genre, weight}]` sorted by weight DESC (stable), truncated to `limit`; weights are the raw sums, not rounded.

## SQL

`HISTORY_MIN_WATCH_SECONDS = 5`, `RESUME_FROM_START_UNDER_SECONDS = 10`. Parameters are positional (`$1` user, `$2` accessible ids array).

**Item of a wire pair** (created by the items migration, redefined by the versions migration; `NULL` for a pair that names no item):
```sql
CREATE OR REPLACE FUNCTION item_of(media integer, episode integer) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN episode IS NULL
    THEN (SELECT min(id) FROM items WHERE "mediaId" = media AND "groupId" IS NULL HAVING count(*) = 1)
    ELSE (SELECT id FROM items WHERE id = episode AND "mediaId" = media) END
$$;
```

**Find state** (params `[userId, itemId]`): `SELECT ps.*, i."mediaId", CASE WHEN i."groupId" IS NOT NULL THEN i.id END AS "episodeId" FROM playback_states ps JOIN items i ON i.id = ps."itemId" WHERE ps."userId" = $1 AND ps."itemId" = $2`. Delete: `DELETE FROM playback_states WHERE "userId" = $1 AND "itemId" = $2`.

**Resume info** (params `[userId, mediaId]`):
```sql
SELECT f.id AS "mediaFileId",
       CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS "episodeId",
       ps."positionSeconds", ps."durationSeconds", s."number", e."number"
 FROM playback_states ps
 JOIN items e ON e.id = ps."itemId"
 LEFT JOIN item_groups s ON s.id = e."groupId"
 LEFT JOIN LATERAL (
   SELECT p."mediaFileId" AS id FROM item_parts p WHERE p."itemId" = e.id
   ORDER BY (p."mediaFileId" = ps."mediaFileId") DESC NULLS LAST, (p."version" = ps."version") DESC NULLS LAST, p."version" DESC, p."position"
   LIMIT 1) f ON true
 WHERE ps."userId" = $1
   AND e."mediaId" = $2
   AND ps.completed = false
   AND ps."positionSeconds" > 0
 ORDER BY ps."lastPlayedAt" DESC
 LIMIT 1
```

**Watched episode ids**:
```sql
SELECT DISTINCT i.id
 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
 WHERE ps."userId" = $1 AND i."mediaId" = $2
   AND ps.completed = true AND i."groupId" IS NOT NULL
```

**Episode progress**:
```sql
SELECT i.id,
        ROUND((ps."positionSeconds" / ps."durationSeconds") * 100) AS percent
 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
 WHERE ps."userId" = $1 AND i."mediaId" = $2
   AND i."groupId" IS NOT NULL
   AND ps.completed = false
   AND ps."durationSeconds" > 0
   AND ps."positionSeconds" > 0
```

**Continue watching** (params `[userId, accessibleLibraryIds, 20]`), one statement:
```sql
WITH st AS (
  SELECT ps.id, ps."itemId", ps."mediaFileId", ps."version", ps."positionSeconds", ps."durationSeconds",
         ps.completed, ps."hiddenFromContinueWatching" AS hidden, ps."lastPlayedAt",
         i."mediaId", i."groupId", i."number" AS inum, g."number" AS gnum
  FROM playback_states ps
  JOIN items i ON i.id = ps."itemId"
  LEFT JOIN item_groups g ON g.id = i."groupId"
  WHERE ps."userId" = $1
),
user_series AS (
  SELECT "mediaId", max("lastPlayedAt") AS "lastPlayedAt"
  FROM st WHERE "groupId" IS NOT NULL AND NOT hidden GROUP BY "mediaId"
),
last_completed AS (
  -- Highest (group, number) among completed items: lastPlayedAt ties when the user bulk-marks a season.
  SELECT DISTINCT ON ("mediaId") "mediaId", gnum, inum
  FROM st WHERE completed AND "groupId" IS NOT NULL
  ORDER BY "mediaId", gnum DESC, inum DESC
),
in_progress AS (
  SELECT DISTINCT ON ("mediaId") id, "mediaId", "itemId", "mediaFileId", "version", "positionSeconds", "durationSeconds"
  FROM st
  WHERE NOT completed AND "positionSeconds" >= 5 AND "groupId" IS NOT NULL
  ORDER BY "mediaId", "lastPlayedAt" DESC
),
next_item AS (
  SELECT lc."mediaId",
         (SELECT e.id FROM items e JOIN item_groups s ON s.id = e."groupId"
          WHERE s."mediaId" = lc."mediaId" AND s."number" > 0
            AND (s."number" > lc.gnum OR (s."number" = lc.gnum AND e."number" > lc.inum))
          ORDER BY s."number", e."number" LIMIT 1) AS "itemId"
  FROM last_completed lc
  WHERE lc."mediaId" NOT IN (SELECT "mediaId" FROM in_progress)
),
picked AS (
  SELECT st.id, st."mediaId", st."itemId", st."mediaFileId", st."version", st."positionSeconds",
         st."durationSeconds", st."lastPlayedAt"
  FROM st
  WHERE st."groupId" IS NULL AND NOT st.completed AND NOT st.hidden AND st."positionSeconds" >= 5
  UNION ALL
  SELECT ip.id, ip."mediaId", ip."itemId", ip."mediaFileId", ip."version",
         ip."positionSeconds", ip."durationSeconds", us."lastPlayedAt"
  FROM in_progress ip
  JOIN user_series us ON us."mediaId" = ip."mediaId"
  UNION ALL
  SELECT COALESCE(ps.id, 0), ni."mediaId", ni."itemId", NULL::int, NULL::int,
         COALESCE(ps."positionSeconds", 0), COALESCE(ps."durationSeconds", 0), us."lastPlayedAt"
  FROM next_item ni
  JOIN user_series us ON us."mediaId" = ni."mediaId"
  LEFT JOIN playback_states ps ON ps."userId" = $1 AND ps."itemId" = ni."itemId"
  WHERE ni."itemId" IS NOT NULL AND COALESCE(NOT ps.completed, true)
)
SELECT x.id, x."mediaId", x.file AS "mediaFileId", x."episodeId", x.pos AS "positionSeconds",
       x.dur AS "durationSeconds", x."lastPlayedAt", x.title AS "mediaTitle",
       x.poster AS "posterUrl", x.fanart AS "fanartUrl", x.kind AS "mediaType",
       x.still AS "stillUrl", x.label AS "episodeLabel",
       CASE WHEN COALESCE(x.dur, 0) > 0 THEN ROUND((x.pos / x.dur) * 100) ELSE 0 END AS "progressPercent"
FROM (
  SELECT c.id, c."mediaId", f.id AS file, c.pos, c.dur, c."lastPlayedAt",
         CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS "episodeId",
         m.title, m."posterUrl" AS poster, m."fanartUrl" AS fanart,
         m.type AS kind,
         e."stillUrl" AS still,
         CASE WHEN e."groupId" IS NOT NULL
              THEN 'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
                   || COALESCE(' - ' || e.title, '') END AS label
  FROM (SELECT id, "mediaId", "itemId", "mediaFileId", "version", "positionSeconds" AS pos,
               "durationSeconds" AS dur, "lastPlayedAt" FROM picked) c
  JOIN media m ON m.id = c."mediaId" AND m."libraryId" = ANY($2)
  JOIN items e ON e.id = c."itemId"
  LEFT JOIN item_groups s ON s.id = e."groupId"
  LEFT JOIN LATERAL (
    SELECT p."mediaFileId" AS id FROM item_parts p WHERE p."itemId" = e.id
    ORDER BY (p."mediaFileId" = c."mediaFileId") DESC NULLS LAST, (p."version" = c."version") DESC NULLS LAST, p."version" DESC, p."position"
    LIMIT 1) f ON true
  WHERE f.id IS NOT NULL
) x
ORDER BY date_trunc('milliseconds', x."lastPlayedAt") DESC, x.kind, x."mediaId"
LIMIT $3
```
Numeric types matter for JSON: `positionSeconds`/`durationSeconds` are `double precision` (a JS number); `ROUND(double)` is `double precision` (number); `id` is `int`; `lastPlayedAt` is `timestamptz` (ISO string in JSON).

**History count** (params `[userId, accessibleLibraryIds]`):
```sql
SELECT COUNT(*) AS cnt
 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
 WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
   AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = i."mediaId" AND mAcl."libraryId" = ANY($2))
```
**History page** (params `[userId, limit, (page-1)*limit, accessibleLibraryIds]`):
```sql
SELECT
   ps.id, e."mediaId", ps."mediaFileId",
   CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS "episodeId",
   ps."positionSeconds", ps."durationSeconds", ps.completed,
   ps."lastPlayedAt",
   m.title AS "mediaTitle", m.type AS "mediaType",
   m."posterUrl", m."fanartUrl", e."stillUrl",
   CASE WHEN ps."durationSeconds" > 0
        THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
        ELSE 0 END AS "progressPercent",
   CASE WHEN e."groupId" IS NOT NULL
        THEN 'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
             || COALESCE(' - ' || e.title, '')
        ELSE NULL END AS "episodeLabel"
 FROM playback_states ps
 JOIN items e ON e.id = ps."itemId"
 JOIN media m ON m.id = e."mediaId"
 LEFT JOIN item_groups s ON s.id = e."groupId"
 WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
   AND m."libraryId" = ANY($4)
 ORDER BY ps."playedAt" DESC
 LIMIT $2 OFFSET $3
```

**Watched media ids** (params `[userId, accessibleLibraryIds]`), `<watched>` the predicate of `media-query.md` Q-W with `:userId` = `$1`:
```sql
SELECT m.id FROM media m WHERE m."libraryId" = ANY($2) AND (<watched>)
```

**Series bulk watched** (params `[userId, mediaId]`):
```sql
INSERT INTO playback_states
  ("userId", "itemId", "mediaFileId",
   "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
SELECT $1, e.id,
       (SELECT p."mediaFileId" FROM item_parts p
         WHERE p."itemId" = e.id
         ORDER BY p."version" DESC, p."position" LIMIT 1),
       0,
       COALESCE(
         (SELECT (mf2."streamInfo"->>'durationSeconds')::float
            FROM media_files mf2 JOIN item_parts p2 ON p2."mediaFileId" = mf2.id
           WHERE p2."itemId" = e.id
           ORDER BY p2."version" DESC, p2."position" LIMIT 1),
         0
       ),
       true,
       NOW()
FROM items e
JOIN item_groups s ON s.id = e."groupId"
WHERE s."mediaId" = $2
  AND s."number" > 0
  AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
ON CONFLICT ("userId", "itemId")
DO UPDATE SET
  completed = true,
  "positionSeconds" = 0,
  "lastPlayedAt" = NOW()
```
**Series bulk unwatched**:
```sql
UPDATE playback_states
   SET completed = false,
       "positionSeconds" = 0,
       "lastPlayedAt" = NOW()
 WHERE "userId" = $1
   AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2 AND "groupId" IS NOT NULL)
```
After the upsert: `SELECT i.id FROM playback_states ps JOIN items i ON i.id = ps."itemId" WHERE ps."userId" = $1 AND i."mediaId" = $2 AND i."groupId" IS NOT NULL AND ps.completed = true`.

**Season toggle** (equivalent SQL): `INSERT INTO playback_states ("userId","itemId","mediaFileId","positionSeconds","durationSeconds",completed,"lastPlayedAt") SELECT $1, e.id, f.id, 0, COALESCE((f."streamInfo"->>'durationSeconds')::float8, 0), true, now() FROM items e CROSS JOIN LATERAL (latest part file of e) f WHERE e."groupId" = $2 ON CONFLICT ("userId","itemId") DO UPDATE SET "mediaFileId" = EXCLUDED."mediaFileId", "positionSeconds" = 0, "durationSeconds" = EXCLUDED."durationSeconds", completed = true, "hiddenFromContinueWatching" = false, "lastPlayedAt" = now() RETURNING "itemId"` (`playedAt` is not in the update); unwatched: `UPDATE playback_states SET completed = false, "positionSeconds" = 0, "lastPlayedAt" = now() WHERE "userId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "groupId" = $2)`.

**toggleWatched file lookup**: `SELECT "mediaFileId" FROM item_parts WHERE "itemId" = $1 ORDER BY "version" DESC, position LIMIT 1`; `SELECT * FROM media_files WHERE id = $1`.

**Hide**: `UPDATE playback_states SET "hiddenFromContinueWatching" = true WHERE "userId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2)`.

**Recommendations** (equivalent SQL):
- window: `SELECT ps.*, m.* FROM playback_states ps LEFT JOIN items i ON i.id = ps."itemId" LEFT JOIN media m ON m.id = i."mediaId" WHERE ps."userId" = $1 AND ps.completed = true ORDER BY ps."lastPlayedAt" DESC LIMIT 15`.
- started media: `SELECT DISTINCT i."mediaId" FROM playback_states ps JOIN items i ON i.id = ps."itemId" WHERE ps."userId" = $1`.
- dismissed: `SELECT d."mediaId" AS "mediaId" FROM recommendation_dismissals d WHERE d."userId" = $1`.
- candidates: `SELECT m.id, m.title, m.type, m.year, m."posterUrl", m."fanartUrl", m."additionalFanartUrls", m.genres FROM media m WHERE m.genres IS NOT NULL AND m.genres != '[]'::jsonb [AND m.id NOT IN (...)] AND m."libraryId" IN (...)`.
- availability (verbatim) (param `$1` = int array of top ids):
```sql
SELECT mf."mediaId" AS "mediaId"
 FROM media_files mf
 WHERE mf."mediaId" = ANY($1)
 GROUP BY mf."mediaId"
 UNION
 SELECT s."mediaId" AS "mediaId"
 FROM media_files mf
 JOIN items e ON e.id = mf."episodeId"
 JOIN item_groups s ON s.id = e."groupId"
 WHERE s."mediaId" = ANY($1)
 GROUP BY s."mediaId"
```
- dismiss: `INSERT INTO recommendation_dismissals ("userId","mediaId") VALUES ($1,$2) ON CONFLICT DO NOTHING` (plus default `createdAt`/`updatedAt`); reset: `DELETE FROM recommendation_dismissals WHERE "userId" = $1`; count: `SELECT COUNT(*) FROM recommendation_dismissals WHERE "userId" = $1`.

`playback_states` is unique on `("userId","itemId")` (`UQ_playback_states_user_item`) and its `"itemId"` is a cascading FK to `items`; `"mediaFileId"` is the last file played, a nullable FK with `ON DELETE SET NULL`, so deleting a file keeps the progress; `"version"` is the version of that file, set by a trigger (`items.md` rule 35) (`server/migrations/1789000000070_progress-on-items.sql`; `"version"` in `server/migrations/1789000000180_item-versions.sql`). `createdAt`/`updatedAt` are `TIMESTAMP` without time zone (`server/migrations/1777816212948_baseline.sql`), so those two fields are excluded from parity.

## Events

none emitted by these routes (the heartbeat's `remote.state` is `heartbeat.md`).

## Settings keys

none.

## Jobs/timers

none.

## Vectors/parity

- Vector set `recommend`: `server/fixtures/recommend/cases.json`, replayed by a Rust test: 74 cases, `getRecommendations` 70, `getTopGenres` 4; input = `{userId, libs, limit?, topLimit?, history[{completed,lastPlayedAt,media}], startedMediaIds, dismissedMediaIds, candidates[{id,title,type,year,posterUrl,fanartUrl?,additionalFanartUrls?,genres,libraryId}], availableRows}`, expected = the item array. The replay replaces the database with stubs that replay the SQL filters (completed + order + take, id NOT IN, library IN, non-empty genres), so rules 21-29 (window, weights, scoring, stratification, `becauseTitle`, rounding, availability mapping) are covered; **SQL semantics, candidate ordering, the 15-row window query, `watched-ids`, continue-watching and history are not** and are covered by parity.
- Parity scenarios (`server/parity/scenarios/playback/`): `recommendations-happy`, `recommendations-library-scope` (accessible, foreign, `0`), `recommendations-limit-clamp`, `recommendation-dismiss-204`, `recommendation-dismissed-count`, `recommendation-dismissed-reset`, `watched-ids`, `continue-watching-movie`, `continue-watching-series-next-up`, `continue-watching-hidden`, `continue-watching-library-scope`, `history-page`, `history-empty-library`, `history-fractional-page-500`, `watched-episodes`, `episode-progress`, `resume-info`, `resume-info-null-empty-body`, `state-get`, `state-get-null-empty-body`, `state-delete`, `hide`, `toggle-watched-movie`, `toggle-watched-episode`, `toggle-watched-no-file`, `toggle-series-watched-on-off`, `toggle-season-watched-on-off`, `toggle-season-wrong-media`, and for each route an unauthenticated 401 and a bad-id 400 where it takes an id. Ignore `$..createdAt`, `$..updatedAt`, `$..lastPlayedAt`, `$..playedAt`, `$..id` of toggled rows.

## Open questions

1. Candidate query of `getRecommendations` has no `ORDER BY`, so equal scores are ordered by Postgres scan order; a defined tie-break (e.g. `ORDER BY m.id`) is not specified.
2. `history` with a fractional `page`/`limit` is a 500 (rule 3): keep or reject with 400?
