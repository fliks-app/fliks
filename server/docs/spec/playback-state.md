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

`PlaybackState` JSON (entity, no `@Exclude`): `id, createdAt, updatedAt, positionSeconds, durationSeconds (nullable), completed, hiddenFromContinueWatching, lastPlayedAt, playedAt (nullable)`, and for a row **loaded** from the DB the `@RelationId` virtuals `userId, mediaId, mediaFileId, episodeId`; a row **just inserted** carries `user:{id}, media:{id}, mediaFile:{id}|absent, episode:{id}|null` instead (see `heartbeat.md` rule 16). `GET.../state` (`findOne`) always has the former shape.

## Rules

### Library-scoped queries

1. `recommendations`: `libraryId = parseInt(libraryIdRaw,10)` when the query value is non-empty; if truthy and finite (`0`/`NaN` are ignored), the scope is `[libraryId]` when it is in the accessible list, else `[]` (silent empty result, not 403); otherwise all accessible ids. `limit` absent -> `undefined` (service default 15); present -> `min(50, max(1, parseInt(limit,10) || 15))` (`0` and non-numeric become 15).
2. `continue-watching`: same `libraryId` rule as 1.
3. `history`: `page = max(1, Number(page) || 1)`, `limit = min(100, max(1, Number(limit) || 25))` (`Number`, not `parseInt`: `page=2.5` gives a fractional `OFFSET` that Postgres rejects -> 500; `limit=2.5` likewise is bound as a non-integer). Scope = all accessible ids.
4. `watched-ids`: scope = all accessible ids.

### State reads and deletes

5. `findState(userId, mediaId, episodeId?)`: a movie row is `"episodeId" IS NULL`; an episode row has that `episodeId`. The controller parses `episodeId` with `parseInt` only when the query value is non-empty; `NaN` and `0` are falsy and select the **movie row**.
6. `GET state`: returns the row or `null` (empty body). `DELETE state`: removes the found row (`DELETE FROM playback_states WHERE id = $1`), no error when absent, 200 empty.
7. `GET media/:id` (resume info): newest not-completed row of the user for that media with `positionSeconds > 0` (any episode), joined to its season/episode numbers; `null` -> empty body; `positionSeconds` is `0` when the stored value is `< 10` (`RESUME_FROM_START_UNDER_SECONDS`), else as stored; `durationSeconds` `Number()`-ed; `seasonNumber`/`episodeNumber` omitted (undefined) when null (movies).
8. `watched-episodes`: distinct `episodeId`s with `completed = true`; no ordering.
9. `episode-progress`: object keyed by episode id with `ROUND(position/duration*100)` for not-completed rows with duration and position `> 0`; only values with `0 < p < 100` are kept (a row at 100 or rounding to 0 is dropped). JSON keys are decimal strings.
10. `hide/:mediaId`: `hiddenFromContinueWatching = true` on **every** row (movie and all episodes) of `(user, media)`; the flag is cleared again by the next heartbeat write (`heartbeat.md` rule 15).

### Continue watching

11. Two queries then a merge (SQL below). Movies: not completed, not hidden, `positionSeconds >= 5` (`HISTORY_MIN_WATCH_SECONDS`), `m.type = 'movie'`, scoped by library; post-processing per row: `mediaType = 'movie'`, `episodeLabel = null`, `positionSeconds` and `progressPercent` `Number()`-ed; when `positionSeconds < 10` both are set to `0` (the item stays listed). Series ("next up"): per series the in-progress episode (latest `lastPlayedAt`, not completed, `positionSeconds >= 5`) else the episode after the highest completed `(season, episode)` (specials `seasonNumber = 0` excluded) when it exists and has a file and is not completed; `mediaType = 'series'`; same `< 10` zeroing; `episodeLabel = 'S' || LPAD(season,2,'0') || 'E' || LPAD(ep,2,'0') || COALESCE(' - ' || title,'')`; `id = 0` when there is no state row for the next episode; `lastPlayedAt` = the series' most recent non-hidden state. Merge: concatenate movies then series, sort by `lastPlayedAt` DESC (JS `Date` compare, stable), `slice(0,20)`. No SQL `LIMIT`.
12. `ContinueWatchingItem` fields: `id, mediaId, mediaFileId (number|null), episodeId (number|null), positionSeconds, durationSeconds, progressPercent, lastPlayedAt, mediaTitle, mediaType, posterUrl, fanartUrl, stillUrl, episodeLabel`; movies have `stillUrl: null`.

### History

13. `history`: rows with `"playedAt" IS NOT NULL` (set by real playback progress only: manual "mark watched" never sets it) for accessible libraries, newest `playedAt` first, `LIMIT $limit OFFSET (page-1)*limit`; `total` = count of the same predicate (as a `Number`). `progressPercent` `Number()`-ed. Empty accessible list -> `{data:[], total:0}`. `WatchHistoryItem` = `id, mediaId, mediaFileId, episodeId, positionSeconds, durationSeconds, progressPercent, completed, lastPlayedAt, mediaTitle, mediaType, posterUrl, fanartUrl, stillUrl, episodeLabel (null for movies)`.
14. `watched-ids`: ids of movies completed by the user plus series whose every non-special episode that has a file (`hasFile = true`, `seasonNumber > 0`) is completed (at least one such episode); union, `DISTINCT` semantics, no ordering; `[]` when no library.

### Watched toggles

15. `toggle-watched` (`toggleWatched`): `existing = findState(user, media, body.episodeId)`; `willBeCompleted = existing ? !existing.completed: true`. For a new row with no `body.mediaFileId`, a file is looked up (`episodeId != null` -> any `media_files` row of that episode, `LIMIT 1`; else the movie file `mediaId = $m AND episodeId IS NULL`); no file found leaves `mediaFileId` **NULL** (the column is nullable). Build a new row from relation objects when none exists. Then `completed = willBeCompleted`; `lastPlayedAt = now`; `mediaFile = {id: fileId}` only when a file id is known; when completing: `positionSeconds = 0`, and if `durationSeconds` is falsy it is read from `media_files."streamInfo"->durationSeconds` of `fileId || state.mediaFileId` (else `0`; no read when neither id exists); un-completing leaves position and duration. `playedAt` is never set or cleared. `repo.save`; when `willBeCompleted`, `removeWatchedFromAutoPlaylists(user, media, episodeId != null ? [episodeId]: null)` through the isolated wrapper (`heartbeat.md` rules 19-20). Returns the saved entity (new-row shape for an insert, loaded-row shape for an update). Ownership of `mediaId`/`episodeId`/`mediaFileId` is not checked: a bogus pair fails with an FK violation (500; here unlike the heartbeat, `23503` is **not** swallowed).
16. `toggle-series-watched` (`toggleSeriesWatched(userId, mediaId, !!body.watched)`): watched: one raw upsert (SQL below) for every episode with `hasFile = true` in seasons with `seasonNumber > 0` of `mediaId`: file = highest `media_files.id` of the episode, `positionSeconds = 0`, `durationSeconds` = that file's `streamInfo->>'durationSeconds'` as float (0 if missing), `completed = true`, `lastPlayedAt = NOW()`; on conflict `("userId","episodeId") WHERE "episodeId" IS NOT NULL`: only `completed = true`, `positionSeconds = 0`, `lastPlayedAt = NOW()` (duration, file and `playedAt` untouched; new rows have `playedAt` NULL). Then loads **all** completed states of `(user, media)` (including ones this call did not touch), maps to non-null episode ids and calls the playlist auto-remove with that list (an empty list returns early inside the playlist method). Unwatched: `UPDATE` every row of `(user, media)` with `episodeId IS NOT NULL` (specials and file-less episodes included) to `completed = false, positionSeconds = 0, lastPlayedAt = NOW()`. Returns `{watched}`. Not transactional.
17. `toggle-season-watched` (`toggleSeasonWatched(userId, mediaId, seasonId, !!body.watched)`): `episodes` = all episodes of `seasonId` (the season is **not** checked against `mediaId`); none -> `{watched}` without any write. Watched: only episodes with `hasFile`; none -> `{watched}`; latest `media_files` row per episode (highest id); **delete** the user's rows for those episodes (`WHERE "userId" = $1 AND "episodeId" IN (...)`, regardless of `mediaId`), then **insert** one row per episode that has a file: `mediaId` = the path `mediaId`, `mediaFileId`, `positionSeconds = 0`, `durationSeconds = file.streamInfo?.durationSeconds ?? 0`, `completed = true`, `lastPlayedAt = now`, `playedAt = null`; when at least one row was inserted call the playlist auto-remove with those episode ids. Unwatched: `UPDATE... SET completed = false, "positionSeconds" = 0, "lastPlayedAt" = now WHERE "userId" = $1 AND "mediaId" = $2 AND "episodeId" IN (all season episode ids)` (here `mediaId` **is** in the predicate: asymmetric). Not transactional (two concurrent watched calls can trip the unique index -> 500). Returns `{watched}`.
18. Delete+insert loses any previous `playedAt` of those rows (history entries of the season's episodes vanish when the season is marked watched); the series-wide upsert keeps them.

18a. Every flip of `completed` to true in rules 15-17 and in the heartbeat appends a `playback_history` row (`cleanup.md` rule 6a); un-completing deletes nothing.

### Recommendations

19. `dismiss(userId, mediaId)`: `INSERT INTO recommendation_dismissals ("userId","mediaId") VALUES ($1,$2) ON CONFLICT DO NOTHING` (`orIgnore`), idempotent on unique `UQ_recommendation_dismissals_user_media (userId, mediaId)`; no check that the media exists or is accessible; 204.
20. `resetDismissals`: `DELETE... WHERE "userId" = $1`, answer `{removed: affected ?? 0}`. `countDismissals`: `SELECT COUNT(*)... WHERE "userId" = $1` -> `{count}`.
21. `getRecommendations(userId, libs, limit?)`: `libs` empty -> `[]`. **History window**: the user's 15 most recent `completed = true` states (`lastPlayedAt` DESC, joined to media); walk them in order; skip a state whose media is missing or has no genres (it still used one of the 15); skip a media id already taken; keep at most 10 unique media, assigning `rank` 0,1,2... only to kept ones; none kept -> `[]`.
22. **Genre profile**: for each kept media with `rank r`, `weight = 1/(r+1)` is added to each of its genres (a genre repeated in one media counts each time); `genreSource[g]` = title of the media that first contributed `g`, replaced by the rank-0 media whenever it contributes `g`.
23. **Exclusions**: the kept media ids, **every** media id the user has any `playback_states` row for (completed or not), and every dismissed media id.
24. **Candidates**: media with `genres IS NOT NULL AND genres != '[]'`, `id NOT IN (excluded)` (clause omitted when the set is empty), `"libraryId" IN (libs)`; columns `id, title, type, year, posterUrl, fanartUrl, additionalFanartUrls, genres`; **no `ORDER BY`**.
25. **Score** per candidate with genres: `total = sum(genreWeights[g] ?? 0)`; `topGenre` = the first genre (candidate order) with the strictly greatest weight; candidates with `total <= 0` are dropped; `score = total / sqrt(candidate.genres.length)`. Stable sort by score DESC (ties keep candidate/DB order).
26. **Stratification**: `TOTAL = limit ?? 15`; `PER_TYPE_CAP = max(10, ceil(TOTAL * 0.7))`; walk `scored`: stop at `TOTAL`; an item whose type already has `PER_TYPE_CAP` items goes to `overflow`, else to `top` and counts for its type; afterwards append `overflow` in order until `TOTAL`. The result is **not** re-sorted after the append.
27. **Availability**: one query for the `top` ids marks `available = true` when the media has at least one `media_files` row directly (movie) or via `episodes -> seasons` (series) (SQL below).
28. **Output item**: `{ media: { id, title, type, year, posterUrl, fanartUrl: m.fanartUrl ?? null, additionalFanartUrls: m.additionalFanartUrls ?? [], genres, available }, becauseTitle: genreSource.get(topGenre) ?? recentMedia[0].media.title, score: Math.round(score * 100) / 100 }`; `year` and `posterUrl` are passed through (JSON `null` when null).
29. `getTopGenres(userId, limit = 8)` (no route here; used by the social profile): same 15-state window, skip/dedup and weights as rules 21-22 (stops after 10 kept media); returns `[{genre, weight}]` sorted by weight DESC (stable), truncated to `limit`; weights are the raw sums, not rounded.

## SQL

`HISTORY_MIN_WATCH_SECONDS = 5`, `RESUME_FROM_START_UNDER_SECONDS = 10`. In the continue-watching text `${libFilter}` is ` AND m."libraryId" = ANY($2)` and `${HISTORY_MIN_WATCH_SECONDS}` is `5`. Parameters are positional (`$1` user, `$2` accessible ids array).

**Resume info** (params `[userId, mediaId]`):
```sql
SELECT
   ps."mediaFileId", ps."episodeId",
   ps."positionSeconds", ps."durationSeconds",
   s."seasonNumber", e."episodeNumber"
 FROM playback_states ps
 LEFT JOIN episodes e ON e.id = ps."episodeId"
 LEFT JOIN seasons s ON s.id = e."seasonId"
 WHERE ps."userId" = $1
   AND ps."mediaId" = $2
   AND ps.completed = false
   AND ps."positionSeconds" > 0
 ORDER BY ps."lastPlayedAt" DESC
 LIMIT 1
```

**Watched episode ids**:
```sql
SELECT DISTINCT ps."episodeId"
 FROM playback_states ps
 WHERE ps."userId" = $1 AND ps."mediaId" = $2
   AND ps.completed = true AND ps."episodeId" IS NOT NULL
```

**Episode progress**:
```sql
SELECT ps."episodeId",
        ROUND((ps."positionSeconds" / ps."durationSeconds") * 100) AS percent
 FROM playback_states ps
 WHERE ps."userId" = $1 AND ps."mediaId" = $2
   AND ps."episodeId" IS NOT NULL
   AND ps.completed = false
   AND ps."durationSeconds" > 0
   AND ps."positionSeconds" > 0
```

**Continue watching, movies**:
```sql
SELECT
        ps.id, ps."mediaId", ps."mediaFileId", ps."episodeId",
        ps."positionSeconds", ps."durationSeconds", ps."lastPlayedAt",
        m.title AS "mediaTitle", m."posterUrl", m."fanartUrl",
        NULL::text AS "stillUrl",
        CASE WHEN ps."durationSeconds" > 0
             THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
             ELSE 0 END AS "progressPercent"
 FROM playback_states ps
 JOIN media m ON m.id = ps."mediaId"
 WHERE ps."userId" = $1
   AND ps.completed = false
   AND ps."hiddenFromContinueWatching" = false
   AND ps."positionSeconds" >= ${HISTORY_MIN_WATCH_SECONDS}
   AND m.type = 'movie'${libFilter}
 ORDER BY ps."lastPlayedAt" DESC
```

**Continue watching, series**:
```sql
WITH user_series AS (
  SELECT DISTINCT ON (ps."mediaId")
         ps."mediaId", ps."lastPlayedAt"
  FROM playback_states ps
  JOIN media m ON m.id = ps."mediaId"
  WHERE ps."userId" = $1 AND m.type = 'series'
    AND ps."hiddenFromContinueWatching" = false
  ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
),
last_completed AS (
  -- Highest (seasonNumber, episodeNumber) among completed episodes —
  -- ordering by lastPlayedAt ties when the user bulk-marks a season,
  -- which would make next_ep target an arbitrary earlier episode.
  SELECT DISTINCT ON (ps."mediaId")
         ps."mediaId", ps."episodeId",
         s."seasonNumber", e."episodeNumber"
  FROM playback_states ps
  JOIN episodes e ON e.id = ps."episodeId"
  JOIN seasons s ON s.id = e."seasonId"
  WHERE ps."userId" = $1 AND ps.completed = true AND ps."episodeId" IS NOT NULL
  ORDER BY ps."mediaId", s."seasonNumber" DESC, e."episodeNumber" DESC
),
in_progress AS (
  SELECT DISTINCT ON (ps."mediaId")
         ps."mediaId", ps."episodeId", ps."mediaFileId",
         ps."positionSeconds", ps."durationSeconds"
  FROM playback_states ps
  WHERE ps."userId" = $1
    AND ps.completed = false AND ps."positionSeconds" >= ${HISTORY_MIN_WATCH_SECONDS}
    AND ps."episodeId" IS NOT NULL
  ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
),
next_ep AS (
  SELECT lc."mediaId",
         (SELECT e.id FROM episodes e
          JOIN seasons s ON s.id = e."seasonId"
          WHERE s."mediaId" = lc."mediaId" AND s."seasonNumber" > 0
            AND (s."seasonNumber" > lc."seasonNumber"
                 OR (s."seasonNumber" = lc."seasonNumber" AND e."episodeNumber" > lc."episodeNumber"))
          ORDER BY s."seasonNumber", e."episodeNumber" LIMIT 1
         ) AS "episodeId"
  FROM last_completed lc
  WHERE lc."mediaId" NOT IN (SELECT "mediaId" FROM in_progress)
),
combined AS (
  SELECT ip."mediaId", ip."episodeId", ip."mediaFileId", ip."positionSeconds", ip."durationSeconds"
  FROM in_progress ip
  UNION ALL
  SELECT ne."mediaId", ne."episodeId", NULL::int AS "mediaFileId", 0.0 AS "positionSeconds", 0.0 AS "durationSeconds"
  FROM next_ep ne WHERE ne."episodeId" IS NOT NULL
)
SELECT
  COALESCE(ps_next.id, 0) AS id,
  c."mediaId",
  COALESCE(c."mediaFileId", mf.id) AS "mediaFileId",
  c."episodeId",
  COALESCE(ps_next."positionSeconds", c."positionSeconds", 0) AS "positionSeconds",
  COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) AS "durationSeconds",
  us."lastPlayedAt",
  m.title AS "mediaTitle",
  m."posterUrl", m."fanartUrl",
  e."stillUrl",
  'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
    || COALESCE(' - ' || e.title, '') AS "episodeLabel",
  CASE WHEN COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) > 0
       THEN ROUND((COALESCE(ps_next."positionSeconds", c."positionSeconds", 0)
                  / COALESCE(ps_next."durationSeconds", c."durationSeconds", 1)) * 100)
       ELSE 0 END AS "progressPercent"
FROM combined c
JOIN user_series us ON us."mediaId" = c."mediaId"
JOIN media m ON m.id = c."mediaId"
JOIN episodes e ON e.id = c."episodeId"
JOIN seasons s ON s.id = e."seasonId"
LEFT JOIN LATERAL (
  SELECT mf2.id FROM media_files mf2
  WHERE mf2."mediaId" = c."mediaId" AND mf2."episodeId" = c."episodeId"
  ORDER BY mf2.id DESC LIMIT 1
) mf ON c."mediaFileId" IS NULL
LEFT JOIN playback_states ps_next ON ps_next."userId" = $1 AND ps_next."mediaId" = c."mediaId" AND ps_next."episodeId" = c."episodeId"
WHERE COALESCE(ps_next.completed, false) = false
  AND COALESCE(c."mediaFileId", mf.id) IS NOT NULL${libFilter}
```
Numeric types matter for JSON: `positionSeconds`/`durationSeconds` are `double precision` (a JS number); `ROUND(double)` is `double precision` (number); `id` is `int`; `lastPlayedAt` is `timestamptz` (ISO string in JSON).

**History count** (params `[userId, accessibleLibraryIds]`):
```sql
SELECT COUNT(*) AS cnt
 FROM playback_states ps
 WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
   AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = ps."mediaId" AND mAcl."libraryId" = ANY($2))
```
**History page** (params `[userId, limit, (page-1)*limit, accessibleLibraryIds]`):
```sql
SELECT
   ps.id, ps."mediaId", ps."mediaFileId", ps."episodeId",
   ps."positionSeconds", ps."durationSeconds", ps.completed,
   ps."lastPlayedAt",
   m.title AS "mediaTitle", m.type AS "mediaType",
   m."posterUrl", m."fanartUrl", e."stillUrl",
   CASE WHEN ps."durationSeconds" > 0
        THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
        ELSE 0 END AS "progressPercent",
   CASE WHEN ps."episodeId" IS NOT NULL
        THEN 'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
             || COALESCE(' - ' || e.title, '')
        ELSE NULL END AS "episodeLabel"
 FROM playback_states ps
 JOIN media m ON m.id = ps."mediaId"
 LEFT JOIN episodes e ON e.id = ps."episodeId"
 LEFT JOIN seasons s ON s.id = e."seasonId"
 WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
   AND m."libraryId" = ANY($4)
 ORDER BY ps."playedAt" DESC
 LIMIT $2 OFFSET $3
```

**Watched media ids** (params `[userId, accessibleLibraryIds]`):
```sql
SELECT DISTINCT ps."mediaId" AS id
FROM playback_states ps
JOIN media m ON m.id = ps."mediaId"
WHERE ps."userId" = $1 AND ps.completed = true AND m.type = 'movie'
  AND m."libraryId" = ANY($2)

UNION

SELECT s."mediaId" AS id
FROM seasons s
JOIN episodes e ON e."seasonId" = s.id
LEFT JOIN playback_states ps
  ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
WHERE s."seasonNumber" > 0 AND e."hasFile" = true
  AND EXISTS (SELECT 1 FROM media m2 WHERE m2.id = s."mediaId" AND m2."libraryId" = ANY($2))
GROUP BY s."mediaId"
HAVING COUNT(*) > 0 AND COUNT(*) = COUNT(ps.id)
```

**Series bulk watched** (params `[userId, mediaId]`):
```sql
INSERT INTO playback_states
  ("userId", "mediaId", "mediaFileId", "episodeId",
   "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
SELECT $1, $2,
       (SELECT mf.id FROM media_files mf
         WHERE mf."episodeId" = e.id
         ORDER BY mf.id DESC LIMIT 1),
       e.id,
       0,
       COALESCE(
         (SELECT (mf2."streamInfo"->>'durationSeconds')::float FROM media_files mf2
           WHERE mf2."episodeId" = e.id
           ORDER BY mf2.id DESC LIMIT 1),
         0
       ),
       true,
       NOW()
FROM episodes e
JOIN seasons s ON s.id = e."seasonId"
WHERE s."mediaId" = $2
  AND s."seasonNumber" > 0
  AND e."hasFile" = true
ON CONFLICT ("userId", "episodeId") WHERE "episodeId" IS NOT NULL
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
   AND "mediaId" = $2
   AND "episodeId" IS NOT NULL
```
After the upsert: `SELECT * FROM playback_states WHERE "userId" = $1 AND "mediaId" = $2 AND completed = true`.

**Season toggle** (equivalent SQL): `SELECT * FROM episodes WHERE "seasonId" = $1`; `SELECT * FROM media_files WHERE "episodeId" IN (...) ORDER BY id DESC`; `DELETE FROM playback_states WHERE "userId" = $1 AND "episodeId" IN (...)`; `INSERT INTO playback_states ("userId","mediaId","mediaFileId","episodeId","positionSeconds","durationSeconds",completed,"lastPlayedAt","playedAt") VALUES (...)` (bulk, `playedAt` NULL); unwatched: `UPDATE playback_states SET completed = false, "positionSeconds" = 0, "lastPlayedAt" = $now, "updatedAt" = now WHERE "userId" = $1 AND "mediaId" = $2 AND "episodeId" IN (...)`.

**toggleWatched file lookups**: `SELECT * FROM media_files WHERE "episodeId" = $1 LIMIT 1` (episode) or `... WHERE "mediaId" = $1 AND "episodeId" IS NULL LIMIT 1` (movie); `SELECT * FROM media_files WHERE id = $1`. No `ORDER BY` on the first two (any matching row).

**Hide**: `UPDATE playback_states SET "hiddenFromContinueWatching" = true, "updatedAt" = now WHERE "userId" = $1 AND "mediaId" = $2`.

**Recommendations** (equivalent SQL):
- window: `SELECT ps.*, m.* FROM playback_states ps LEFT JOIN media m ON m.id = ps."mediaId" WHERE ps."userId" = $1 AND ps.completed = true ORDER BY ps."lastPlayedAt" DESC LIMIT 15`.
- started media: `SELECT DISTINCT ps."mediaId" AS "mediaId" FROM playback_states ps WHERE ps."userId" = $1`.
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
 JOIN episodes e ON e.id = mf."episodeId"
 JOIN seasons s ON s.id = e."seasonId"
 WHERE s."mediaId" = ANY($1)
 GROUP BY s."mediaId"
```
- dismiss: `INSERT INTO recommendation_dismissals ("userId","mediaId") VALUES ($1,$2) ON CONFLICT DO NOTHING` (plus default `createdAt`/`updatedAt`); reset: `DELETE FROM recommendation_dismissals WHERE "userId" = $1`; count: `SELECT COUNT(*) FROM recommendation_dismissals WHERE "userId" = $1`.

`playback_states` unique partial indexes: `server/migrations/1783400000000_index-playback-state-unique-per-target.sql` (`idx_playback_user_movie`, `idx_playback_user_episode`). In the baseline `playback_states."mediaFileId"` is a nullable FK (`ON DELETE CASCADE`) and `createdAt`/`updatedAt` are `TIMESTAMP` without time zone (`server/migrations/1777816212948_baseline.sql`), so those two fields are excluded from parity.

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
3. `toggle-season-watched` does not verify `seasonId` belongs to `mediaId` and deletes the user's history stamps (`playedAt`) for the season (rules 17-18): keep or change?
