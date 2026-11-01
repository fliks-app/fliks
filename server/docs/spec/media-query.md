# Spec: media-query (`/api/media` read routes)

Scope: the 15 read routes of `/api/media`. Library ACL rules live in `libraries.md` (rules 30-36, cited "libraries rule N"); auth, CASL and error-body rules in `auth.md` ("auth rule N"). Release-quality subset: rules 69-70.

Not covered here: the `/api/media` write routes, the four companions routes and `DELETE /api/libraries/:id` (`media-write.md`); the 14 `/api/media/:id/subtitles*` routes and `GET /api/media/sync-queue` (`subtitles.md`).

## Routes

15 routes.

Every route requires a credential (JWT or API key) and the policy `ability.can(Action.Read, Media)` = permission `media.read` or `manage:all` (auth rules 20, 25); all answer 200. Failure shapes: 401 (auth rule 14), 403 `Forbidden resource` (auth rule 27), 404 `{"message":"Media #<id> not found","error":"Not Found","statusCode":404}` (auth rule 15). A `scope:'stream'` token is answered 401 on all 15 (none is a stream-allowed delivery route). The literal routes (`recently-added`, `counts`, `counts-by-library`, `qualities`, `genres`, `collections`, `calendar`) win over `:id` (axum's literal-over-param matching); `GET /api/media/sync-queue` is registered explicitly by the subtitles router, so it never reaches `GET /api/media/{id}`. `:id` and `:mediaFileId` are integer path params (rule 3).

`MLI` = media list item (rule 30), `MD` = media detail (rule 31), `RI` = related item (rule 55).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/media` | credential; `Read Media` | query `SearchMediaDto` (rules 4-8): `q, type, status, monitored, year, genre, genres, yearMin, yearMax, voteMin, collectionId, qualityProfileId, languageProfileId, sortBy, sortOrder, page, limit, libraryId, missing, cutoffUnmet, unidentified, letter, excludeWatched, onlyWatched, requestedByMe`; unknown key = 400 | `{ data: MLI[], total: number }` (rules 14-29) | 400 validation (rule 4); 401; 403; numeric edge input is 400 (rule 9) | none |
| `GET /api/media/recently-added` | same | query `RecentlyAddedDto { libraryId?: number, limit?: number (default 20), mode?: 'media'\|'file'\|'both' (default 'file'), excludeWatched?: bool, requestedByMe?: bool }` | `MLI[]` **without** `watched`/`progressPercent` (rules 32-34) | 400 (also on `limit < 0`, rule 9), 401, 403 | none |
| `GET /api/media/counts` | same | none (query ignored) | `{ movies: number, series: number }` | 401, 403 | none |
| `GET /api/media/counts-by-library` | same | none | `{ [libraryId: string]: number }` (rule 36) | 401, 403 | none |
| `GET /api/media/qualities` | same | none | `QualityDefinition[]` (24 rows, rule 37), no DB access, no ACL | 401, 403 | none |
| `GET /api/media/genres` | same | query `libraryId?: string` (not a DTO: other keys ignored, rule 38) | `{ genre: string, count: number, posters: string[] }[]` | 401, 403 | none |
| `GET /api/media/collections` | same | query `libraryId?: string` (rule 38) | `{ id: number, name: string, count: number, posters: string[] }[]` | 401, 403 | none |
| `GET /api/media/calendar` | same | query `CalendarQueryDto { start?: ISO-8601, end?: ISO-8601, type?: 'movie'\|'series', monitoredOnly?: bool, requestedByMe?: bool }` | `CalendarEntry[]` (rules 47-51) | 400 (also on a date Postgres rejects, rule 9), 401, 403 | none |
| `GET /api/media/:id/tracking` | same | path `id` int | `TrackingStatus` (rules 43-46) | 400 `Validation failed (numeric string is expected)`; 404 `Media #<id> not found`; 401; 403 | none |
| `GET /api/media/:id` | same | path `id` int | `MD` (rule 31) | 400; 404 `Media #<id> not found`; 401; 403 | none |
| `GET /api/media/:id/similar` | same | path `id`; query `limit?: string` (not a DTO, rule 53) | `RI[]` (rules 52-56) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/collection` | same | path `id` | `{ id: number, name: string, items: RI[] }` or **200 with an empty body** (rule 57) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/cast` | same | path `id` | `MediaCast[]` (rule 58) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/crew` | same | path `id` | `MediaCrew[]` (rule 58) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/streams/:mediaFileId` | same | path `id`, `mediaFileId` int | `{ streamIndex: number, type: 'audio'\|'subtitle', codec: string, language: string, title?: string }[]` (rules 59-61) | 400; 404 `Media #<id> not found` / `MediaFile #<id> not found`; 400 or 404 (never 500) when the library has no path (rule 60); 401; 403 | engine `POST /v1/probe` (read-only) |

## Rules

### A. Auth, parameters, validation

1. Authorization is `media.read` (or `manage:all`) on every route; the per-object check is the library ACL (section B), not CASL conditions. `GET /api/media/qualities` has no object and no ACL.
2. `request.user` is always a real user, so every user-scoped option (`excludeWatched`, `requestedByMe`, watched/progress) applies.
3. `:id` / `:mediaFileId` use the shared `PathParams<i32>` (`server/crates/server/src/http/validate.rs`): only plain decimal integers within int4 are accepted; `abc`, `1.5`, `1e1`, `0x10`, `0b11`, ` 7 ` and values beyond int4 (`99999999999`) are 400 `{"statusCode":400,"message":"Validation failed (numeric string is expected)","error":"Bad Request"}`; `-5` passes and 404s. Guards run before the path check (auth rule 17).
4. Query strings: a repeated key becomes an array, `a=` is `''`, a bare key is `''`, `+` decodes to space, no bracket syntax (`genres[]=x` is an unknown key). The validation pipe (`whitelist`, `forbidNonWhitelisted`, `transform`) applies to the three DTO routes only (`GET /api/media`, `recently-added`, `calendar`): an unknown key = 400 `{"message":["property <k> should not exist"],"error":"Bad Request","statusCode":400}`. Routes reading `libraryId` / `limit` as bare strings ignore every other key.
5. Coercions (explicit, no implicit conversion, auth rule 16): a number coercion on `year, yearMin, yearMax, voteMin, collectionId, qualityProfileId, languageProfileId, page, limit, libraryId` (and `libraryId, limit` of `RecentlyAddedDto`): `Number(string)`, so `''` becomes `0`, `'1e3'` 1000, `'0x10'` 16, `' 7 '` 7; `IsNumber` then rejects `NaN`/`Infinity` (400 `<k> must be a number conforming to the specified constraints`); an array value (`year=1&year=2`) becomes an array of numbers, which `IsNumber` rejects with the same 400. Booleans (`monitored, missing, cutoffUnmet, unidentified, excludeWatched, onlyWatched, requestedByMe, monitoredOnly`): **only the exact string `true` is true**; `TRUE`, `1`, `yes`, `''`, an array are all `false` and never fail validation.
6. Strings: `q, genre, sortBy, sortOrder, letter` are `IsString` (an array = 400 `<k> must be a string`); `sortOrder` is typed `'ASC'|'DESC'` but not validated as an enum. Enums: `type` ∈ `movie|series` (400 `type must be one of the following values: movie, series`), `status` ∈ `tba|announced|released|ended|continuing|deleted`, `mode` ∈ `media|file|both`; an optional field skips only an absent or `null` value, so `?type=` (empty) is 400.
7. `genres`: an array of strings after a transform: an array value is mapped to trimmed strings with empty ones dropped; a string is split on `,`, each part trimmed, empties dropped (`?genres=` gives `[]`); `genres=a,b` and `genres=a&genres=b` are equivalent.
8. `CalendarQueryDto.start|end`: validated as non-strict ISO 8601 (`2026-03-01`, `2026-03-01T10:00:00Z`, `20260301`, week dates all pass); only the first 10 characters are used (rule 47).
9. Numeric inputs the DTO lets through and Postgres rejects are 400 with the standard validation body: non-integer or out-of-int4 `year, yearMin, yearMax, qualityProfileId, languageProfileId, collectionId, libraryId`, `page < 1` **with `limit > 0`** (with `limit <= 0` there is no `OFFSET` and `page` is ignored, 200), `limit < 0` on `recently-added`, `page`/`limit` whose `LIMIT`/`OFFSET` literal leaves int8 (`1e20`) or prints in exponent form (`1e21`), calendar dates Postgres cannot parse (rule 47). A `sortBy` naming an `Object.prototype` member is not an error: it is an unknown key and falls back to `title` (rule 17). `LIMIT`/`OFFSET` are inlined as number text and Postgres rounds a numeric literal half away from zero (`LIMIT 2.5 OFFSET 2.5` returns rows 4-6, `LIMIT 0.4` none), so fractional `page`/`limit` succeed. A `q` word longer than 2047 characters is **not** an error: `to_tsquery` drops it with a NOTICE.
10. A handler returning `null`/`undefined` answers **200 with an empty body** (no `Content-Type`), not JSON `null`; `[]` and `{}` are JSON. Only `GET :id/collection` returns `null` (rule 57).

### B. Library ACL

11. Every route except `qualities` computes `ids = accessible_library_ids(user)` once (libraries rule 30: every `libraries.id` for `isAdmin`/`manage:all`, else the `library_user_access` rows of the user; no order). Per-media routes then run `assert_media_accessible(:id, ids)` first (libraries rule 32): no row, `libraryId IS NULL` (also for admins) or `libraryId` not in `ids` = 404 `Media #<id> not found` (same body for missing and denied). The SQL clause is `"libraryId" = ANY($ids)` (libraries rule 34).
12. Empty `ids`: list = `{ data: [], total: 0 }`, `recently-added` = `[]`, `counts` = `{ movies: 0, series: 0 }`, `counts-by-library` = `{}`, `genres` / `collections` = `[]` (early return), `calendar` = `[]`. The handlers short-circuit to these bodies. Media with `libraryId IS NULL` match no ACL clause and never appear in any list, count or calendar.
13. Any `libraryId` filter (list, recently-added, genres, collections) narrows **inside** the ACL (AND), never widens it. Per-media routes check only the target media; `similar` and `collection` candidates are restricted to the source media's library (accessible because the source passed the gate), `cast`/`crew` persons carry no ACL.

### C. `GET /api/media` (list)

14. Defaults and pagination: `page = query.page ?? 1`, `limit = query.limit ?? 25`, `offset = (page - 1) * limit`; pagination applies only when `limit > 0` (`limit <= 0`, including `0` and negatives, returns **every** matching row and `total` of the same set, without a second `COUNT(*)`). There is no upper bound on `limit`.
14a. `view=grid` (only value; anything else is 400) is the library grid shape: `files` holds only the media's first file (`id ASC`) with its `streamInfo`, and `fileCount` (number of files) is added; every other key of the `MLI` is unchanged, `sizeOnDisk` still sums all files. Without `view` the shape of rule 30 is returned.
15. Query shape: `FROM media` with LEFT JOINs `library`, `qualityProfile`, `languageProfile`, `files` (`media_files` on `"mediaId"`), then ACL (`"libraryId" = ANY(ids)`), then the filters, then the user-scoped clauses, then FTS, then the sort. All clauses are ANDed.
16. **Parent-id pagination**: page `SELECT media.id ... ORDER BY <col> <dir>, media.id ASC LIMIT/OFFSET` (the id tie-break is **always ASC**, whatever `sortOrder`), `COUNT(*)` over the same `WHERE` (no duplicates exist once `files` is an `EXISTS`, rule 22), then hydrate in the page order. Page membership and the order inside a page are deterministic (`id ASC` breaks equal sort keys).
17. Sort: `sortBy` is looked up in `{ title: media.title, year: media.year, added: media."createdAt", createdAt: media."createdAt", rating: media.rating }`; any other value (including `''`, `Title`, SQL text, `constructor`, `__proto__`) silently falls back to `title`; default `title`. `sortOrder`: `DESC` only when exactly the string `DESC`, otherwise `ASC` (`desc`, `Desc`, junk all give ASC). No `NULLS` clause: Postgres defaults apply (`ASC` nulls last, `DESC` nulls first), so `year`/`rating` NULLs sort last ascending. Text and `title` ordering is Postgres' own (database default collation, case/accent rules of the DB), never done in application code.
18. `q` present and `sortBy` absent: order by `ts_rank(media."searchVector", <TSQ>) DESC NULLS LAST, media.title ASC, media.id ASC` (a NULL rank, i.e. a row without vector matched by ILIKE/similarity, sorts last; `sortOrder` is ignored). "Absent" means the key is missing: an empty or unknown `sortBy` is present and falls back to `title` (rule 17). With `sortBy` present the requested sort applies (rule 17). The selected `ts_rank` column is not part of the response. The search page omits `sortBy` unless the user chose one.
19. Filters (each only when its guard holds; the table is exhaustive; param types are the SQL column types, `enum` = `media.type` (`text` with a `CHECK`) / `media_status_enum`):

    | Param | Guard | SQL | Notes |
    |---|---|---|---|
    | `libraryId` | truthy (`0` ignored) | `media."libraryId" = $n` | inside the ACL (rule 13) |
    | `type` | truthy | `media.type = $n` | enum |
    | `status` | truthy | `media.status = $n` | enum |
    | `monitored` | `!== undefined` (`false` applies) | `media.monitored = $n` | rule 5 coercion |
    | `year` | truthy (`0` ignored) | `media.year = $n` | NULL year never matches |
    | `yearMin` / `yearMax` | `!== undefined` (`0` applies) | `media.year >= $n` / `<= $n` | NULL excluded |
    | `voteMin` | `!== undefined` | `media.rating >= $n` | float, NULL excluded |
    | `genre` | truthy | `media.genres @> $n::jsonb` with `$n = JSON.stringify([genre])` | jsonb array containment: exact element, case-sensitive, NULL `genres` excluded |
    | `genres` | `length > 0` | `media.genres @> $n::jsonb` with `$n = JSON.stringify(genres)` | all listed genres must be present (AND); combines with `genre` by AND |
    | `collectionId` | truthy | `EXISTS (SELECT 1 FROM media_tmdb_collection c WHERE c."mediaId" = media.id AND c."tmdbId" = $n)` | |
    | `qualityProfileId` | truthy | `media."qualityProfileId" = $n` | |
    | `languageProfileId` | truthy | `media."languageProfileId" = $n` | |
    | `missing` | `!== undefined` | rule 22 | |
    | `unidentified` | `=== true` | `NOT EXISTS (SELECT 1 FROM media_external_ids WHERE "mediaId" = media.id)` | identified means any external id (`external-ids.md` rule 7); an empty `imdbId` is not stored, so it does not count |
    | `letter` | truthy | rule 23 | |
20. User-scoped clauses (only with a user, always true): `(excludeWatched || onlyWatched)` adds `media.id <op> (<watched subquery>)` with `op = onlyWatched ? IN : NOT IN` (so `onlyWatched` wins when both are set); `requestedByMe` adds `media."addedById" = $user` (approved requests and direct imports both set `addedById`). The watched subquery is the SQL of Q-W below: a movie is watched when the user's `playback_states` row for its item is `completed`; a series when it has at least one episode with a file in a season `> 0` and **every** such episode has a completed row of the user (specials excluded; a series with no file-backed episodes is never watched).
21. `total` = number of distinct media matching all clauses above (not reduced by `cutoffUnmet`, rule 26, nor by `limit`).
22. `missing` (rule 19) is, with `today` = the **UTC** date `YYYY-MM-DD` computed in application code (not `CURRENT_DATE`): `missing=true` → `(files.id IS NULL OR <ME>)`, `missing=false` → `(files.id IS NOT NULL AND NOT <ME>)`, where `files.id IS NULL` means the media has no `media_files` row (`NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = media.id)`) and `<ME>` is Q-M below ("a monitored season (> 0) holds a monitored episode, aired on or before today, not on disk"). An episode with `airDate IS NULL` is never missing; an unmonitored series with gaps is still missing; a movie is missing iff it has no file. "On disk" = the episode has an item part (`items.md` rule 21): a multi-episode file gives a part to every existing episode of its range, so the episodes inside it are on disk without any range arithmetic.
23. `letter`: `letter = query.letter.toUpperCase()` (Unicode upper-casing); `'#'` → `media.title !~ '^[A-Za-z]'` (title not starting with an ASCII letter, evaluated by Postgres); a single ASCII `A`-`Z` → `UPPER(LEFT(media.title, 1)) = $letter` (database `UPPER`; titles starting with an accented letter do not match their base letter); anything else (two characters, `1`, `É`, lowercase that does not upper-case into `A-Z`) adds **no filter** and no error.
24. **Full-text search** (`q` truthy; `''` = no search; whitespace-only is truthy):
    - Prefix tsquery: `q.trim().split(/\s+/)` (whitespace set of JS `trim`: includes U+FEFF, excludes U+0085), each word stripped of every character that is not `\p{L}` or `\p{N}`, empty results dropped, each remaining word suffixed `:*`, joined with ` & ` → `$tsq` (`star wars` → `star:* & wars:*`). The code uses the `regex` crate classes `\p{L}`/`\p{N}` and that whitespace set, not `char::is_alphabetic`/`split_whitespace`.
    - `<TSQ>` = `to_tsquery('french', $tsq)` when `$tsq` is non-empty, else `plainto_tsquery('french', $q)` (which yields an empty query for symbol-only input: the `@@` branch is then false and only the ILIKE/similarity branches can match). Text-search configuration is **`french`** (not `simple`), no `websearch_to_tsquery`; stop words drop out of the query inside Postgres.
    - Predicate: `( media."searchVector" @@ <TSQ> OR media.title ILIKE $like OR media."originalTitle" ILIKE $like OR similarity(media.title, $q) > 0.8 )` with `$q` the **untrimmed** raw `q`, `$like = '%' || q || '%'` unescaped (a user `%`, `_` or `\` keeps its LIKE meaning), `similarity` from `pg_trgm` (migration `1786400000000_pg_trgm.sql`). `searchVector` is NULL for a row never indexed: only the other three branches can match it.
    - Order: by rank when `sortBy` is absent, else the requested sort (rule 18).
25. `attachEpisodeStats` runs on the page: `sizeOnDisk = Σ Number(file.size)` over the loaded `files` (number, `0` when none); for series, one query (Q-S below, `"downloaded"` counts the episodes with a part, season 0 excluded) gives `episodeStats: { totalEpisodes: number, downloadedEpisodes: number }`, **absent** (key omitted) for movies and for series without episodes in seasons `> 0`.
26. `cutoffUnmet === true` is applied in SQL before pagination: `page`, `limit` and `total` count only the media that pass. A media is kept only if it has a quality profile whose `cutoff` id resolves in the quality table (`cutoffRank`; no profile or unknown id = dropped). Movies: kept when the best `rankFromQualityString(file.quality)` over `files` (0 with none) is `< cutoffRank`. Series: per monitored episode of seasons `> 0`, the best file rank (`rankFromQualityString`, 0 for no file or empty quality, Q-C below); a series with no such episodes is dropped; `shadowedEpisodeNumbers` is computed over **all** those episodes of the media pooled across seasons (a multi-episode range in season 1 also shadows the same numbers in season 2); kept when some non-shadowed episode has `rank < cutoffRank`. `rankFromQualityString` = `0` for null/empty else `parseReleaseQuality(q).quality.rank` (rule 69). Ranks come from `parseReleaseQuality`, not from an exact name match, so SQL cannot rank by itself: the filtering uses a `(quality text, rank int)` mapping built from the distinct `media_files.quality` strings of the filtered media, or a pre-filter of the ids before paging. A page is full unless it is the last.
27. `attachWatchedProgress` runs last on the (post-cutoff) page: for each media `watched: boolean` (`=== true`) and `progressPercent: number` from the SQL of Q-P: movies resume % = `ROUND(positionSeconds / durationSeconds * 100)::int` of the **most recent** incomplete row of the media's ungrouped item (`groupId IS NULL`, `completed = false`, `durationSeconds > 0`, `ORDER BY "lastPlayedAt" DESC LIMIT 1`), `0` otherwise and always `0` for series; `watched` uses the same definition as rule 20. The percentage stays in SQL: `positionSeconds`/`durationSeconds` are `float8` and `round(float8)` rounds half to even (`450/3600` gives 12, not 13), unlike `f64::round`.
28. Response `{ data, total }`; media serialise as the `MLI` of rule 30.
29. Per request: ACL ids; page ids; count; hydrate (media + the three many-to-one joins + `files` by `ANY(ids)` ordered `id ASC`, rule 30); episode stats; cutoff queries only when requested; watched/progress.

### D. Entity shapes (list and detail)

30. `MLI` (list and `recently-added` item) = the media as a JSON object:
    - all `media` columns **except** `searchVector` (`select: false`) and the three provider ids, which are assembled from `media_external_ids` (`external-ids.md` rules 5 and 13): `id, createdAt, updatedAt` (ISO `%Y-%m-%dT%H:%M:%S%.3fZ`), `title, originalTitle` (string\|null), `alternativeTitles` (string[]), `year` (int\|null), `type`, `tmdbId, imdbId, tvdbId` (\|null), `overview`, `status`, `monitored`, `preferredProvider`, `folderName`, `posterUrl, fanartUrl, logoUrl` (\|null), `additionalFanartUrls` (string[]), `metadataRefreshedAt` (ISO\|null), `rating` (float\|null), `genres` (string[]\|null), `tmdbCollectionId, tmdbCollectionName` (from the view `media_tmdb_collection`, `media-details.md` rule 18, `null` without a collection), `runtime`, `releaseDate, inCinemas, digitalRelease, physicalRelease` (`YYYY-MM-DD` strings\|null, assembled from `media_release_dates`, `media-details.md` rules 2-3), `minimumAvailability`; nullable columns are present as `null`;
    - `path`: `null` unless `library.path` is truthy; when `folderName` is truthy `path.join(library.path, folderName)` (POSIX normalisation: `//` collapsed, `.`/`..` resolved), else `library.path` verbatim;
    - relation-id fields `libraryId, qualityProfileId, languageProfileId, addedById`: always present, `null` when the foreign key is null ;
    - joined relations: `library` (object\|null: all `libraries` columns + `defaultQualityProfileId`/`defaultLanguageProfileId`, `null` when unset), `qualityProfile` (object\|null: `id, createdAt, updatedAt, name, cutoff, items, upgradeAllowed, resolutionUpgradeOnly, minCustomFormatScore`), `languageProfile` (object\|null: `id, createdAt, updatedAt, name, audioLanguages, subtitleLanguages`), `files` (array, `[]` when none): `id, createdAt, updatedAt, relativePath, size` (**JSON number**, transformer `Number(v)`), `quality` (string), `language` (string\|null), `streamInfo` (jsonb\|null, returned whole, plus an additive `trackMarkers` string array on every `audio[]`/`subtitles[]` entry: `playback-info.md` rule 23a), `osdbHash` (string\|null, varchar 16), `osdbBytesize` (**number**\|null, bigint with transformer), `mediaId` (always), `episodeId` (`null` for a movie file);
    - derived: `sizeOnDisk`, `episodeStats?` (rule 25), `watched`, `progressPercent` (rule 27; absent on `recently-added`);
    - **not present**: `metadata`, `seasons`, `cast`, `crew`, `addedBy`, `searchVector` ). `libraryId`, `files[].episodeId` and `library.defaultQualityProfileId` are present as `null` when unset.
31. `MD` (`GET :id`) = the media loaded with relations `seasons, seasons.episodes, files, qualityProfile, languageProfile, library, metadata`: the `MLI` columns/`path`/relation ids/joined relations of rule 30 **plus** `seasons` (array, `[]` when none; each `id, createdAt, updatedAt, seasonNumber, monitored, preferredProvider, posterUrl, overview, airDate` (string\|null, varchar), `mediaId`, `episodes[]`) and `metadata`; **no** `sizeOnDisk`, `episodeStats`, `watched`, `progressPercent`. Episode: `id, createdAt, updatedAt, episodeNumber, endEpisodeNumber, title, overview, airDate` (`YYYY-MM-DD`\|null), `runtime, monitored, hasFile, stillUrl, markersScannedAt` (ISO\|null), `seasonId` (no `searchVector`). `metadata` (`movie_details` or `series_details`, built by `media_details_json`, `media-details.md` rule 13): `id, createdAt, updatedAt, budget, revenue` (**strings** or null: bigint, always null for a series), `tagline, popularity` (float), `voteCount, originalLanguage, productionCountries, productionCompanies, videos, keywords` (jsonb); when the media has no metadata row the key is `null` (parity `detail-no-metadata`).
32. Detail post-processing: seasons sorted with `seasonNumber 0` (specials) **last**, the others ascending; episodes of each season ascending by `episodeNumber`; `hasFile` of an episode is derived: true when it has an item part (`items.md` rule 21), so an episode inside a multi-episode file reports `true`. 404 `Media #<id> not found` when the row vanished after the gate. `files` are ordered `id ASC`.
33. `recently-added`: limit `query.limit ?? 20` (`0` gives `[]` via `LIMIT 0`; negative = 400, rule 9), mode `query.mode ?? 'file'`, user clauses only when `excludeWatched || requestedByMe`. Pass 1 ranks ids with Q-R below, pass 2 loads the full `MLI` (library, profiles, files joins, `id IN ids`), restores the pass-1 order and runs `attachEpisodeStats` only. Mode `media`: `ORDER BY media."createdAt" DESC`; `file`: only media with a file, `ORDER BY lf.added DESC` (newest `media_files."createdAt"` per media); `both`: `ORDER BY GREATEST(media."createdAt", COALESCE(lf.added, media."createdAt")) DESC`. Ties break on `media.id ASC`. `libraryId` (truthy) is ANDed with the ACL.
34. `recently-added` items carry no `watched` / `progressPercent` (watched/progress are not computed); `excludeWatched` filters with `media.id NOT IN (<watched subquery>)` (no `onlyWatched` here).

### E. Counts, genres, collections, qualities

35. `counts`: one `GROUP BY type` count over `media` with the ACL clause, folded through the kind registry into `{movies, series}` (`MediaKind::count_key()`), zero-filled; numbers (`media-details.md` rule 10).
36. `counts-by-library`: `SELECT m."libraryId", COUNT(*)::int FROM media m WHERE m."libraryId" IS NOT NULL AND m."libraryId" IN ids GROUP BY m."libraryId"` → `Object.fromEntries`: JSON object keyed by the library id as a string, libraries without media absent, keys in ascending numeric order (a `BTreeMap<String, _>` would put `10` before `2`). `/api/counts` uses the same per-library counts (`counts.md`).
37. `qualities` returns the static `APP_QUALITIES` array unchanged (24 rows, order below; keys `id, name, resolution, source, rank`):

    | id | name | res | source | rank | | id | name | res | source | rank |
    |---|---|---|---|---|---|---|---|---|---|---|
    | 1 | WORKPRINT | 0 | workprint | 5 | | 13 | WEBRip-720p | 720 | web | 45 |
    | 2 | CAM | 0 | cam | 8 | | 14 | Bluray-720p | 720 | bluray | 50 |
    | 3 | TELESYNC | 0 | telesync | 10 | | 15 | HDTV-1080p | 1080 | hdtv | 55 |
    | 4 | TELECINE | 0 | telecine | 12 | | 16 | WEBDL-1080p | 1080 | web | 62 |
    | 5 | DVD | 480 | dvd | 18 | | 17 | WEBRip-1080p | 1080 | web | 60 |
    | 6 | DVD-R | 480 | dvd | 20 | | 18 | Bluray-1080p | 1080 | bluray | 68 |
    | 7 | SDTV | 480 | sdtv | 22 | | 19 | Remux-1080p | 1080 | remux | 72 |
    | 8 | WEBDL-480p | 480 | web | 28 | | 20 | HDTV-2160p | 2160 | hdtv | 75 |
    | 9 | WEBRip-480p | 480 | web | 28 | | 21 | WEBDL-2160p | 2160 | web | 82 |
    | 10 | Bluray-480p | 480 | bluray | 30 | | 22 | WEBRip-2160p | 2160 | web | 80 |
    | 11 | HDTV-720p | 720 | hdtv | 40 | | 23 | Bluray-2160p | 2160 | bluray | 88 |
    | 12 | WEBDL-720p | 720 | web | 45 | | 24 | Remux-2160p | 2160 | remux | 95 |

    The constant is pinned by the golden fixture `app-qualities` (Vectors).
38. `genres` and `collections`: `libraryId` handling: `libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null` (`parseInt` semantics); when truthy and finite the scope is `[libraryId]` if it is in `ids`, else `[]`; `''`, `0`, `NaN` (`abc`) leave the scope at `ids`; `12abc` parses to 12; a repeated key (`libraryId=1&libraryId=2`) is read as the string `'1,2'`, so `parseInt` gives 1. Empty scope returns `[]` without SQL. `genres` = Q-G (one row per distinct genre string, **case-sensitive**, ordered `genre ASC` by database collation; `count` counts occurrences, so a genre repeated inside one media's array counts twice; `posters` = up to 4 non-null `posterUrl`s ordered by `media.id`, `[]` when none). `collections` = Q-K (only named collections of the view `media_tmdb_collection` with `COUNT(*) >= 2` within the scope; grouped by collection, `id` its tmdb value, ordered by name `ASC`, equal names break on `id ASC`).

### F. Tracking

39. `getTrackingStatus(id)`: `findOne(id)` (rule 32), `profile = media.qualityProfile`, `cutoffDef = getAppQualityById(profile.cutoff)` (undefined for no profile or unknown id), `targetQuality = label(cutoffDef)` where `label(def) = def.resolution > 0 ? '<resolution>p' : def.name`.
40. `stateOf(monitored, files)` (each `files` item has `quality`): not monitored → `{ monitored, state: 'unmonitored' }`; no `cutoffDef` → `{ monitored, state: 'no-profile' }`; no files → `{ monitored, state: 'missing' }`; else `best` = highest-`rank` `parseReleaseQuality(file.quality).quality` (first wins on equal rank); `best.rank >= cutoffDef.rank` → `{ monitored, state: 'met', currentQuality: label(best) }`; else `sameResolution = best.resolution === cutoffDef.resolution` and `{ monitored, state: 'below', currentQuality: sameResolution ? best.name : label(best), targetQuality: sameResolution ? cutoffDef.name : targetQuality }`. Absent keys are omitted (undefined). `stateOf` calls `parseReleaseQuality` directly, so an empty `quality` string parses to `Bluray-480p` (rank 30) here while `rankFromQualityString('')` is 0 in `cutoffUnmet` (rule 26).
41. Movie: `{ type: 'movie', hasProfile: !!profile, movie: stateOf(media.monitored, media.files) }` (all files of the media).
42. Series: `{ type: 'series', hasProfile: !!profile, seasons: [{ seasonNumber, episodes: TrackingEpisode[] }] }`: seasons in `findOne` order (specials last, seasons without episodes listed with `episodes: []`); files are grouped by item through their parts (a file without a part is ignored; a range file counts for each episode it plays); an episode is **hidden** when its number lies in `(episodeNumber, endEpisodeNumber]` of another episode of the same season (range only, independent of `hasFile`); each visible episode is `{ episodeId: id, seasonNumber, episodeNumber, endEpisodeNumber: endEpisodeNumber ?? null, title (string\|null), ...stateOf(episode.monitored, filesOfEpisode) }`. `hasProfile` is true even when the cutoff id is unknown (state then `no-profile`). The media's own `monitored` is not consulted for series.
43. `hasProfile`, `state` ∈ `unmonitored|no-profile|missing|below|met` are client-matched strings.
44. `parseReleaseQuality` and `getAppQualityById` serve `tracking` and `cutoffUnmet` (rule 69). `parseReleaseQuality`: lower-cased, `.` replaced by space, source/resolution regexes, candidate selection, fuzzy fallback; a resolution with no table bucket (`4320p`/`8K`, `576p`, `360p`) leaves the fuzzy list empty and returns **`WORKPRINT`** (id 1, rank 5, resolution 0) as `quality`, with a display-only label `<res>p (<nearest>)` (`4320p (HDTV-2160p)`, `576p (DVD)`) that neither `tracking` nor `cutoffUnmet` reads.
45. Neither `tracking` nor the detail route is cached; both are recomputed per request.
46. `TrackingEpisode.title` comes from `items.title` (nullable).

### G. Calendar

47. Window: both `start` and `end` given → each `.slice(0, 10)`; otherwise (including only one of them) the **current month in the server's local time zone** (first day to the last day of that month; the process local zone, not UTC). The sliced strings go to Postgres unparsed (`BETWEEN :start AND :end` against `date` columns), so what Postgres accepts decides: `2026-03-01`, compact `20260301`, ordinal `2026-060` work; `2026-03`, `2026`, `2026031`, week dates and `2026-02-30` pass the DTO (rule 8) but are a Postgres error, answered 400 (rule 9). The raw strings are bound as text cast to `date` in SQL, the cast error is mapped to 400, and they are not reformatted (rule 48 compares the raw strings).
48. Media of the kinds without groups, `movie` (`type` unset, or that kind): `m.type = ANY(<those kinds>) AND EXISTS (<a row of media_release_dates with date BETWEEN $s AND $e>)` (inclusive, `date` column; the four kinds of `media-details.md` are `cinema`, `digital`, `physical`, `release`), `+ m.monitored = true` when `monitoredOnly`, `+ m."addedById" = $user` when `requestedByMe`, ACL (`1 = 0` when empty else `m."libraryId" IN ids`), with `files` left-joined (`hasFile = files.length > 0`). For each movie one entry per specific date inside the window in the order `cinema` (`inCinemas`), `digital` (`digitalRelease`), `physical` (`physicalRelease`); if **none** of the three is inside the window and `releaseDate` is, one entry `event: 'release'`. "Inside the window" is a **string** comparison `d >= start && d <= end` of the `YYYY-MM-DD` column value against the raw sliced `start`/`end`, not the SQL `BETWEEN`: with `start=20260301` SQL selects the movies but `'2026-03-05' < '20260301'` lexically, so no movie entry is emitted (episodes, filtered in SQL only, still are).
49. Episodes (when `type` unset or a kind with groups, `series`; `type` selects the branch holding its kind, and rule 48 only takes that kind): `episodes ep INNER JOIN item_groups season INNER JOIN media media WHERE ep."airDate" BETWEEN $s AND $e`, `+ media.monitored = true AND ep.monitored = true` when `monitoredOnly`, `+ media."addedById" = $user` when `requestedByMe`, ACL as above, `ORDER BY ep."airDate" ASC`; season 0 episodes are **included**. `hasFile` = the episode has an item part (`onDisk`, SQL in Q-D).
50. Entry shape (undefined keys omitted): movie `{ id: media.id, mediaId: media.id, title, type: <the media's kind>, event, date: 'YYYY-MM-DD', posterUrl, fanartUrl, status, year, hasFile }`; episode `{ id: episode.id, mediaId, title: <series title>, type: 'series', event: 'airing', date, posterUrl, fanartUrl, status, year, seasonNumber, episodeNumber, episodeTitle: episode.title, hasFile }`. `posterUrl`/`fanartUrl`/`year` may be `null`; `id` collides across kinds (the client keys on type).
51. Final order: `results.sort((a, b) => a.date.localeCompare(b.date))` (stable, ISO dates so plain lexical): ties keep insertion order = movies `ORDER BY m.id` (per movie cinema, digital, physical, release) then episodes `ORDER BY ep."airDate", ep.id`.

### H. Related, cast, crew

52. `GET :id/similar`: loads the source with `metadata`; `type !== 'movie'` or no library → `[]`; `genres = source.genres ?? []`, `keywords = metadata?.keywords ?? []`, `directors` = person ids of the `media_credits` rows of the source with `role = 'crew'` and `job = 'Director'` (exact, case-sensitive), `sameDirectorIds` = distinct `media_credits."mediaId"` of other media with `role = 'crew'`, `job = 'Director'` and `"personId" IN directors` (any library; excludes the source id); no genres, no keywords and no same-director ids → `[]`.
53. `limit` query (bare string): `Number(limit)`; finite and `> 0` → `Math.min(parsed, 30)` (fractional kept, then `Array.slice` truncates), anything else (absent, `''`, `0`, negative, `abc`) → default **12**.
54. Candidates (Q-X below): media with the **same library and `type = 'movie'`, `id != source`**, where `jsonb_exists_any(m.genres, <source genres>)` (exact, case-sensitive element match) **OR** `jsonb_exists_any(meta.keywords, <source keywords>)` **OR** `m.id IN sameDirectorIds` (each branch only if its list is non-empty), and, when the source has a collection in `media_tmdb_collection`, no candidate of that collection (collection mates excluded); the keywords are those of `movie_details` (rule 54 only reads movies). `hasFile` = media has at least one `media_files` row.
55. Score (f64, evaluate in exactly this order so floats match): `score = 0`; `+= min(keywordHits * 1.6, 4.8)` where `keywordHits` = number of candidate keywords whose lower-case is in the lower-cased set of the source keywords (candidate duplicates counted); `+= cosine(sourceGenres, candidateGenres) * 2.5` where `cosine = shared / sqrt(a.length * b.length)` (0 when `shared = 0`, `shared` counted like `keywordHits`); `+= 2` when same director; when both years are truthy `+= max(0, 1 - |Δyear| / 20) * 0.5`. Keep when `score >= 1`; sort `score DESC`, then `(rating ?? 0) DESC`, **stable over the SQL row order** (`m.id ASC`); take `limit`. Item `RI` = `{ id, title, year, posterUrl: posterUrl ?? null, fanartUrl: fanartUrl ?? null, rating: rating ?? null, genres: genres ?? [], hasFile: boolean }` (`year` may be `null`). Lower-casing is Unicode `str::to_lowercase`; vectors cover non-ASCII.
56. 404 `Media #<id> not found` when the source vanished after the gate.
57. `GET :id/collection`: source without a collection in `media_tmdb_collection` or without library → `null` (**200, empty body**, rule 10); else every media of the **same library** in the same collection (any `type`), `ORDER BY` the `release` date of `media_release_dates` `ASC NULLS LAST, m.year ASC NULLS LAST, m.id ASC`, including the source itself; fewer than 2 rows → `null`; else `{ id: <the collection's tmdb id>, name: <its name>, items: RI[] }`.
58. `cast`: the `media_credits` of the media with `role = 'cast'` and its `person`, `ORDER BY position ASC, id ASC`; `crew`: those with `role = 'crew'`, same order. Cast row `{ id, createdAt, updatedAt, character, order, person }`, crew row `{ id, createdAt, updatedAt, job, department, person }` (no `media` key); `order` is `position`; `person` = all `persons` columns except `searchVector`, with `provider` and `tmdbId` read from the view `person_ids`: `id, createdAt, updatedAt, provider, tmdbId, name, avatarUrl, biography, birthday, deathday` (`YYYY-MM-DD`\|null), `placeOfBirth, knownForDepartment, departments` (string[]), `metadataRefreshedAt` (ISO\|null). A media without credits gives `[]`.

### I. Streams

59. `GET :id/streams/:mediaFileId`: gate (rule 11), `findOne(id)` (rule 32), the file with `id = mediaFileId` among the media's files; none (including a file of another media) = 404 `MediaFile #<mediaFileId> not found`. Path = `path.join(media.path, file.relativePath)` where `media.path` is rule 30's getter; the engine probe gets `path.resolve(<that>)`.
60. When `media.path` is null (library without `path`), the route answers 400 or 404, never 500.
61. Probe: engine `POST /v1/probe {media:{mediaFileId:0,path}}` through the engine client (`engine-glue.md` probe row). An engine that is down, disabled, answers non-2xx or reports an error returns **`[]`** (200), never an error. Success: `[...audio.map(s => ({...s, type:'audio'})), ...subtitles.map(s => ({...s, type:'subtitle'}))]` sorted ascending by `streamIndex` (stable: audio before subtitle on equal index), each mapped to `{ streamIndex, type, codec, language, title }` (`title` omitted when absent).

### J. Search vector

62. Derivation: `media."searchVector" = setweight(to_tsvector('french', COALESCE(title,'')), 'A') || setweight(to_tsvector('french', COALESCE("originalTitle",'')), 'B') || setweight(to_tsvector('french', COALESCE(overview,'')), 'C')`: it reads only columns of the same `media` row (not the detail tables).
63. A database trigger maintains the vector, so no Rust persist path writes it: migration `server/migrations/<ts>_media_search_vector.sql` defines the function `media_search_vector_update()` computing the expression of rule 62 into `NEW."searchVector"` and `CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", overview ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update()`, with a one-time backfill `UPDATE media SET "searchVector" = <expr>` run with the `set_updated_at` trigger disabled (so the backfill does not bump every `updatedAt`). `BEFORE` triggers fire alphabetically (`media_search_vector` before `set_updated_at`), no interaction. `to_tsvector('french', …)` with a literal regconfig is immutable so the expression is legal in the function. The migration also creates the GIN index (rule 65).
63a. `media.title` and `media."originalTitle"` carry `gin_trgm_ops` indexes so the `ILIKE '%q%'` clauses of rule 24 do not scan the table.
64. The vector is derived only by the trigger: no application code writes `searchVector`.
65. `CREATE INDEX idx_media_search_vector ON media USING gin ("searchVector")` (created by the rule 63 migration); no trigram index. `persons."searchVector"` (`to_tsvector('simple', name)`) is maintained by the persons code (`persons.md`).
66. The parity seed populates `searchVector` with the rule 62 expression for every media row, so FTS-only matches are deterministic.

## SQL

Notation: `$ids` = accessible library ids (`int4[]`), `$user` = caller id. The queries below are the SQL the handlers run.

**Q-A (ACL, libraries rules 30, 32)** `SELECT id FROM libraries` (admin) / `SELECT "libraryId" FROM library_user_access WHERE "userId" = $1`; `SELECT m."libraryId" AS "libraryId" FROM media m WHERE m.id = $1`.

**Q-L1 (list: page ids)** rules 15-24 (`<where>` = ACL + filters + user clauses + FTS, all ANDed):

```sql
SELECT media.id
FROM media
WHERE media."libraryId" = ANY($ids) AND <filters> AND <user clauses> AND <fts>
ORDER BY <sort col> <ASC|DESC>, media.id ASC
LIMIT $limit OFFSET $offset          -- only when limit > 0
```

**Q-L2 (list: total)** `SELECT COUNT(*) FROM media WHERE <same where>`.

**Q-L3 (list: hydrate)** (`.*` below stands for the entity columns of rule 30, never `searchVector`; a null FK column gives a `null` relation-id key, rule 30) `SELECT media.*, library.*, "qualityProfile".*, "languageProfile".* FROM media LEFT JOIN libraries library ON library.id = media."libraryId" LEFT JOIN quality_profiles ... LEFT JOIN language_profiles ... WHERE media.id = ANY($page_ids)`; `SELECT * FROM media_files WHERE "mediaId" = ANY($page_ids) ORDER BY id`; reassemble in `$page_ids` order.

**Q-W (watched subquery, verbatim)**:

```sql
  SELECT DISTINCT i."mediaId" AS id FROM playback_states ps
  INNER JOIN items i ON i.id = ps."itemId"
  INNER JOIN media m ON m.id = i."mediaId"
  WHERE ps."userId" = :userId AND ps.completed = true AND m.type = 'movie'
  UNION
  SELECT m2.id FROM media m2
  WHERE m2.type = 'series'
  AND EXISTS (
    SELECT 1 FROM item_groups s
    JOIN items e ON e."groupId" = s.id
    WHERE s."mediaId" = m2.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM item_groups s
    JOIN items e ON e."groupId" = s.id
    WHERE s."mediaId" = m2.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
    AND NOT EXISTS (
      SELECT 1 FROM playback_states ps2
      WHERE ps2."userId" = :userId AND ps2."itemId" = e.id AND ps2.completed = true
    )
  )
```

**Q-M (missing-episode predicate)**:

```sql
EXISTS (
  SELECT 1 FROM item_groups ms JOIN items me ON me."groupId" = ms.id
  WHERE ms."mediaId" = media.id AND ms."number" > 0
    AND ms.monitored = true AND me.monitored = true
    AND me."airDate" <= $today AND NOT EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = me.id)
)
```

**Q-S (episode stats, page series ids)**:

```sql
SELECT s."mediaId",
       COUNT(e.id) AS total,
       COUNT(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)) AS downloaded
FROM item_groups s
JOIN items e ON e."groupId" = s.id
WHERE s."mediaId" = ANY($1) AND s."number" > 0
GROUP BY s."mediaId"
```

**Q-C (cutoff episodes)** verbatim:

```sql
SELECT s."mediaId" AS "mediaId",
       e.id      AS "epId",
       e."number" AS "episodeNumber",
       e."endNumber" AS "endEpisodeNumber",
       f."quality" AS "quality"
  FROM item_groups s
  JOIN items e ON e."groupId" = s.id
  LEFT JOIN item_parts p ON p."itemId" = e.id
  LEFT JOIN media_files f ON f.id = p."mediaFileId"
 WHERE s."mediaId" = ANY($1)
   AND s."number" > 0
   AND e.monitored = true
```

**Q-P (watched/progress, verbatim)**; `$1` = user, `$2` = page ids:

```sql
SELECT m.id::int AS id,
  (
    (m.type = 'movie' AND EXISTS (
      SELECT 1 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
      WHERE ps."userId" = $1 AND i."mediaId" = m.id AND ps.completed = true
    ))
    OR
    (m.type = 'series'
      AND EXISTS (
        SELECT 1 FROM item_groups s JOIN items e ON e."groupId" = s.id
        WHERE s."mediaId" = m.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM item_groups s JOIN items e ON e."groupId" = s.id
        WHERE s."mediaId" = m.id AND s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM playback_states ps2
            WHERE ps2."userId" = $1 AND ps2."itemId" = e.id AND ps2.completed = true
          )
      )
    )
  ) AS watched,
  CASE WHEN m.type = 'movie' THEN COALESCE((
    SELECT ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)::int
    FROM playback_states ps JOIN items i ON i.id = ps."itemId"
    WHERE ps."userId" = $1 AND i."mediaId" = m.id AND i."groupId" IS NULL
      AND ps.completed = false AND ps."durationSeconds" > 0
    ORDER BY ps."lastPlayedAt" DESC LIMIT 1
  ), 0) ELSE 0 END AS progress
FROM media m
WHERE m.id = ANY($2::int[])
```

**Q-R (recently-added ids)** rule 33 (`<user>` = optional `AND media.id NOT IN (<Q-W with $user>)` / `AND media."addedById" = $user`; `<lib>` = optional `AND media."libraryId" = $n`):

```sql
SELECT media.id AS id
FROM media
LEFT JOIN (SELECT mf."mediaId" AS "mediaId", MAX(mf."createdAt") AS added
           FROM media_files mf GROUP BY mf."mediaId") lf ON lf."mediaId" = media.id   -- modes file, both
WHERE media."libraryId" = ANY($ids) <lib> <user>
  [AND lf.added IS NOT NULL]                                                         -- mode file
ORDER BY lf.added DESC                                  -- file
       | media."createdAt" DESC                          -- media (no join)
       | GREATEST(media."createdAt", COALESCE(lf.added, media."createdAt")) DESC   -- both
LIMIT $limit
```

then hydrate as Q-L3 with `media.id = ANY(ids)` in the Q-R order.

**Q-G (genres, verbatim)**:

```sql
SELECT g.genre,
       COUNT(*)::int AS count,
       COALESCE(
         (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
          FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
         ARRAY[]::text[]
       ) AS posters
FROM media m
CROSS JOIN LATERAL jsonb_array_elements_text(m.genres) AS g(genre)
WHERE m."libraryId" = ANY($1)
  AND m.genres IS NOT NULL
  AND m.genres::text != '[]'
GROUP BY g.genre
ORDER BY g.genre ASC
```

**Q-K (collections, verbatim)**:

```sql
SELECT tc."tmdbId"            AS id,
       tc.name                AS name,
       COUNT(*)::int          AS count,
       COALESCE(
         (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
          FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
         ARRAY[]::text[]
       ) AS posters
FROM media m
JOIN media_tmdb_collection tc ON tc."mediaId" = m.id
WHERE m."libraryId" = ANY($1)
  AND tc.name <> ''
GROUP BY tc."collectionId", tc."tmdbId", tc.name
HAVING COUNT(*) >= 2
ORDER BY tc.name ASC, tc."tmdbId" ASC
```

**Q-N (counts)** `SELECT type, COUNT(*) FROM media WHERE "libraryId" = ANY($ids) GROUP BY type` (`1 = 0` when `$ids` empty), folded into `{movies, series}`.

**Q-D (calendar)** equivalent, rules 47-51:

```sql
-- movies
SELECT m.*, dates.*, f.id AS file_id FROM media m LEFT JOIN media_files f ON f."mediaId" = m.id
LEFT JOIN LATERAL (<the four dates of media-details.md rule 3>) dates ON true
WHERE m.type = ANY($kinds_without_groups)
  AND EXISTS (SELECT 1 FROM media_release_dates d WHERE d."mediaId" = m.id AND d.date BETWEEN $s AND $e)
  [AND m.monitored = true] [AND m."addedById" = $user] AND m."libraryId" = ANY($ids)
-- episodes
SELECT ep.id, ep."number", ep.title, ep."airDate",
       season."number", media.id AS "mediaId", media.title AS "mediaTitle",
       media."posterUrl", media."fanartUrl", media.status, media.year,
       EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = ep.id) AS "onDisk"
FROM items ep
INNER JOIN item_groups season ON season.id = ep."groupId"
INNER JOIN media media ON media.id = season."mediaId"
WHERE ep."airDate" BETWEEN $s AND $e
  [AND media.monitored = true AND ep.monitored = true] [AND media."addedById" = $user]
  AND media."libraryId" = ANY($ids)
ORDER BY ep."airDate" ASC
```

**Q-X (similar candidates)** equivalent, rules 52-54:

```sql
SELECT m.*, meta.id, meta.keywords, (SELECT COUNT(*) FROM media_files f WHERE f."mediaId" = m.id) AS "fileCount"
FROM media m LEFT JOIN movie_details meta ON meta."mediaId" = m.id
WHERE m."libraryId" = $source_library AND m.type = 'movie' AND m.id != $source
  AND ( 1 = 0
        OR jsonb_exists_any(m.genres, ARRAY[$genres...])          -- if source genres
        OR jsonb_exists_any(meta.keywords, ARRAY[$keywords...])   -- if source keywords
        OR m.id IN ($sameDirectorIds...) )                        -- if any
  AND NOT EXISTS (SELECT 1 FROM media_tmdb_collection c WHERE c."mediaId" = m.id AND c."tmdbId" = $source_collection)   -- if source has one
```

Director lookups: `SELECT crew."personId" FROM media_credits crew WHERE crew."mediaId" = $1 AND crew.role = 'crew' AND crew.job = 'Director'`; `SELECT crew."mediaId" FROM media_credits crew WHERE crew."personId" IN (...) AND crew.role = 'crew' AND crew.job = 'Director' AND crew."mediaId" != $1`.

**Q-F (collection)** `SELECT m.*, (SELECT COUNT(*) FROM media_files f WHERE f."mediaId" = m.id) AS "fileCount" FROM media m LEFT JOIN LATERAL (<the dates>) dates ON true JOIN media_tmdb_collection c ON c."mediaId" = m.id WHERE m."libraryId" = $lib AND c."tmdbId" = $c ORDER BY dates.release_date ASC NULLS LAST, m.year ASC NULLS LAST`.

**Q-O (detail)** `SELECT * FROM media WHERE id = $1` then one query per relation (strategy `query`): `item_groups WHERE "mediaId"`, `items WHERE "groupId" = ANY`, `media_files WHERE "mediaId"`, `quality_profiles`, `language_profiles`, `libraries`, `media_details_json(id)`.

**Q-CC (cast / crew)** `SELECT mc.*, p.*, x.* FROM media_credits mc JOIN persons p ON p.id = mc."personId" LEFT JOIN person_ids x ON x."personId" = p.id WHERE mc."mediaId" = $1 AND mc.role = $2 ORDER BY mc.position ASC, mc.id ASC`, `$2` being `'cast'` or `'crew'`.

**Q-T (search vector trigger, rule 63)**:

```sql
CREATE FUNCTION media_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('french', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('french', COALESCE(NEW."originalTitle", '')), 'B') ||
    setweight(to_tsvector('french', COALESCE(NEW.overview, '')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", overview
  ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update();
```

### K. Behaviours pinned by tests

67. Full-text ordering: `q` present and `sortBy` absent orders by rank (rule 18).
68. `cutoffUnmet=true` filters before pagination (rule 26). Its quirks stay: no profile or unknown cutoff id = dropped, a movie without files has rank 0, series shadowing pooled across seasons, series with no monitored episode in seasons `> 0` dropped.
69. Release-quality subset: `parseReleaseQuality`, `rankFromQualityString`, `getAppQualityById` and `APP_QUALITIES` (rules 44, 37) live in `fliks_domain` with their vectors (`release-quality`, `app-qualities`); `release.md` extends the module.
70. The same `fliks_domain` quality module serves the import code; the shared vectors guard it.
71. No 500 on catalog input: non-integer or out-of-range integer filters, `page < 1` with `limit > 0`, `limit < 0` on `recently-added`, `page`/`limit` beyond int8, calendar dates Postgres cannot parse (rule 47), a null on a non-nullable field: 400 with the standard validation body; a `sortBy` naming an `Object.prototype` member: `title` (rule 17); path ids that are not plain decimals or exceed int4: 400 (`PathParams`, rule 3); unknown ids: 404; `streams` on a library without `path`: 400 or 404 (rule 60).
72. Every list has a final tie-break `id ASC`: `GET /api/media` (after the sort, rule 16), `recently-added` (rule 33), `collections`, `similar`, `collection`, `cast`, `crew`, `calendar`, `files` of a media, and the `seasons`/`episodes` of `MD` and `tracking` among equal `seasonNumber`/`episodeNumber`. Parity compares equal-key arrays order-insensitively.
73. `path` (the `Media.path` of rule 30) and `library.path` are serialised only for callers who can manage libraries (`settings.access` or `manage:all`, the `Manage Library` ability); for every other `media.read` caller both keys are absent from `MLI` (list, `recently-added`) and `MD`. `tracking`, `streams`, `RI`, calendar and cast/crew carry no absolute path. In the seed only `admin` keeps them. `files[].relativePath` and `streamInfo` are not absolute paths and stay.
74. `GET :id/collection` with no collection answers 200 with an empty body (rules 10, 57); `metadata` bigints (`budget`, `revenue`) are strings; only the exact string `true` is a true boolean query parameter (rule 5); `streams` answers `[]` when the engine is down (rule 61).
75. The library-ACL helpers (`accessible_library_ids`, `assert_media_accessible`, the per-library counts) are shared with `counts.md` and the plugin object guards (libraries rules 30-36).

## Events

none (read-only routes).

## Settings keys

none (no `app_settings` key is read by these routes).

## Jobs/timers

none.

## Vectors/parity

Vector sets (fixtures under `server/fixtures`, replayed by Rust tests, `BLESS=1` convention): `media-search-query` (rule 24 prefix tsquery builder: ~40 inputs incl. accents, apostrophes `l'impossible`, digits, `U+0085`/`U+FEFF`/`U+00A0` separators, symbol-only, empty after trim), `media-similarity` (`scoreSimilarity` + `sharedCount`/`cosineOverlap`, fixed-seed combinations incl. duplicates, case differences, null years), `app-qualities` (the 24-row array), `release-quality` (`parseReleaseQuality` + `rankFromQualityString` on a corpus of stored `media_files.quality` strings and release names, needed by `tracking`/`cutoffUnmet`, rule 69), `media-path` (rule 30 `path`: normalisation, empty `folderName`, null library path). Filter behaviour is asserted through the parity scenarios below.

**Seed** (`server/parity/seed/build.sh` plus a media-query extension: deterministic SQL, no external calls): distinct `createdAt` per media and per `media_files` (days apart) so `added` and recently-added are deterministic; ≥ 30 media in total (default page 25 has a second page); varied `year` (incl. NULL, 0-free), `rating` (incl. NULL, ties), `genres` (`["Drama"]`, `["Action","Drama"]`, `["Comedy"]`, NULL, `[]`, one lower-case `drama`); titles with a lowercase first letter, a digit first (`12 Angry Men`), an accented first letter (`Éclair`), an apostrophe (`L'Impossible`), a French stem pair (`Les Évadés`) and `originalTitle`/`overview` text; `searchVector` populated with the rule 62 expression; one media with `"libraryId" IS NULL`; media with a quality profile (`cutoff` = 18) and files of mixed quality (`WEBDL-720p`, `Bluray-1080p`, `''`, an 8K name); a series with a multi-episode file (`endEpisodeNumber`), an unmonitored episode, a specials season 0, episodes with far-past (`2000-01-01`) and far-future (`2099-01-01`) `airDate` and no file (never relative to "today"); a fully watched series and a half-watched one for `onlyWatched`; `addedById` set on some media; two media in one TMDB collection in library 1, one alone, one in library 2; `movie_details` and `series_details` rows with `keywords`, `budget`/`revenue`; `persons` + `person_external_ids` + `media_credits` (cast with equal `position`, crew with a `Director`); calendar dates inside a fixed month (`2026-03`); media files under `/tmp/fliks-parity/media` for `streams` (engine up). Also needed to pin rules 19-27, 40 and 48: two media with no external id (`unidentified`); an unmonitored movie and `status` values beyond `released`/`continuing`; a movie with **no** `media_files` row (`missing`, `cutoffUnmet` rank 0, recently-added `file` mode, `similar` `hasFile: false`); a language profile on one media; a quality profile whose `cutoff` is not a table id (`99`); a monitored, aired, file-less episode inside an **unmonitored** season (not missing) and a shadowed episode with a past `airDate` covered by its owner's file (not missing); a series with no file-backed episode (never watched); an incomplete movie playback of `450/3600` for `user` (progress 12, half-even); movies in `2026-03` (dates are `media_release_dates` rows) with `inCinemas`+`digitalRelease` inside, with only `releaseDate` inside, and with `releaseDate` inside but `inCinemas` outside. The extension's `createdAt` values are written **after** `build.sh`'s normalising block (it sets every `createdAt`/`updatedAt` to `2026-01-01`). Seeded users: `admin` (all libraries), `user`/`other`/`manager` (libraries 1-2), `readonly` (library 1 only).

**Parity scenarios** (`server/parity/scenarios/media/`; pagination/sort scenarios with equal keys use the runner's `unordered` for `$.data`). The seed has a `noread` actor (role with no permissions + user) for the 403 cases.

| Scenario | Covers |
|---|---|
| `list-default-admin`, `list-default-user`, `list-default-readonly` | defaults (`page 1`, `limit 25`, `title ASC`), ACL scoping (readonly sees library 1 only), shape of `MLI` (rule 30 key presence: `libraryId`, `files[].episodeId` absent for movies, `episodeStats` absent for movies), `watched`/`progressPercent` per actor |
| `list-unauthenticated`, `list-stream-token`, `list-forbidden-noread` | 401, stream-token 401, 403 |
| `list-page-2`, `list-page-beyond-end` (`data: []`, `total` kept), `list-limit-small`, `list-limit-zero` (all rows), `list-limit-negative` (all rows), `list-limit-fraction` (`limit=2.5`: 3 rows), `list-page-zero` (400), `list-page-zero-limit-zero` (200, all rows) | rules 9, 14, parent-id pagination, count |
| `list-sort-title-desc`, `list-sort-year-asc/desc` (NULL placement), `list-sort-rating` (ties, `unordered`), `list-sort-added`, `list-sort-createdAt`, `list-sort-unknown-key` (falls back to title), `list-sort-lowercase-desc` (`desc` is ASC), `list-sort-ties-pages` (page membership with equal keys, DESC id tie-break ASC), `list-sort-proto-key` (`constructor`: falls back to title) | rules 16-17 |
| `list-filter-type`, `-status`, `-monitored-true`, `-monitored-false`, `-monitored-garbage` (`yes` = false), `-year`, `-year-zero` (ignored), `-yearmin-zero`, `-yearmin-yearmax`, `-votemin`, `-libraryid`, `-libraryid-outside-acl` (empty), `-collectionid`, `-qualityprofileid`, `-languageprofileid`, `-year-fraction` (400), `-votemin-empty` (`''` = 0 excludes NULL ratings) | rule 19 guards and null handling |
| `list-filter-genre`, `-genre-case` (`drama` vs `Drama`), `-genres-comma`, `-genres-repeated`, `-genres-empty`, `-genre-and-genres` | jsonb containment, AND semantics, case sensitivity |
| `list-filter-missing-true`, `-missing-false`, `-unidentified`, `-letter-a`, `-letter-lower`, `-letter-hash`, `-letter-accent` (`É` no filter), `-letter-two-chars` (no filter) | rules 22-23 |
| `list-filter-excludewatched`, `-onlywatched`, `-both-watched-flags`, `-requestedbyme`, `-cutoffunmet-movies`, `-cutoffunmet-series-shadowed`, `-cutoffunmet-unknown-cutoff` (dropped), `list-progress-half-even`, `-cutoffunmet-page-total` (full pages, `total` counts only the media that pass) | rules 20, 26 |
| `list-search-prefix` (`impos`), `-search-two-words`, `-search-accent`, `-search-stopword`, `-search-symbols-only`, `-search-ilike-wildcard` (`%`, `_`), `-search-similarity` (typo > 0.8), `-search-original-title`, `-search-whitespace-only`, `-search-with-sort` (requested sort applied), `-search-rank-order` (no `sortBy`: rank order), `-search-null-vector` (row without vector found only through ILIKE), `-search-long-word` (3000-character word ignored, 200) | rule 24, 18 |
| `list-validation-unknown-key`, `-bad-type`, `-bad-status`, `-nan-year` , `-array-q`, `-bad-boolean-array` | 400 bodies (messages compared by `statusCode` + `error`) |
| `recently-added-file`, `-media`, `-both`, `-limit`, `-limit-zero`, `-library`, `-excludewatched`, `-requestedbyme`, `-bad-mode`, `-unauthenticated`, `-shape-no-watched`, `-limit-negative` (400), `-limit-fraction` | rules 33-34 |
| `counts-admin`, `-user`, `-readonly`, `-unauthenticated`; `counts-by-library-admin`, `-readonly`, `-unauthenticated` | rules 35-36, key type |
| `qualities-ok`, `qualities-unauthenticated`, `qualities-stream-token` | rule 37, stream token 401 |
| `genres-all`, `genres-library`, `genres-library-outside-acl`, `genres-library-garbage` (`abc`, `0`, `12abc`), `genres-readonly`, `genres-empty-scope`; `collections-all`, `-library`, `-outside-acl`, `-single-member-hidden` | rule 38, posters ordering |
| `calendar-month`, `-explicit-range`, `-only-start` (current month: fixed via an explicit range in the other scenarios; this one asserts only shape), `-type-movie`, `-type-series`, `-monitoredonly`, `-requestedbyme`, `-readonly-scope`, `-shadowed-episode-hasfile`, `-release-fallback`, `-season0-included`, `-compact-dates` (`20260301`..`20260331`: episodes only), `-bad-date` (`2026-02-30`, `2026-03`: 400), `-bad-type` | rules 47-51 |
| `tracking-movie-met`, `-movie-below`, `-movie-no-profile`, `-movie-missing`, `-movie-unmonitored`, `-movie-below-same-resolution` (names, not labels), `-unknown-cutoff` (`hasProfile: true`, `no-profile`), `-8k-file` (`WORKPRINT`), `-empty-quality` (`Bluray-480p`), `-series-multi-episode`, `-series-specials-last`, `-notfound`, `-outside-acl`, `-badid`, `-unauthenticated` | rules 39-46 |
| `detail-movie`, `detail-series` (season order, specials last, episode order, `hasFile` from parts, a multi-episode file reporting `true` on the episode inside its range), `detail-no-metadata` (`metadata: null`), `detail-with-metadata` (bigint strings), `detail-notfound`, `detail-null-library` (404 even for admin), `detail-outside-acl`, `detail-badid`, `detail-id-out-of-range` (400), `detail-id-noncanonical` (`%207%20`, `1e1`: 400), `detail-unauthenticated`, `detail-movie-user` (`path`, `library.path` absent; every non-admin `MLI`/`MD` scenario carries it) | rules 3, 31-32, 73 |
| `similar-default`, `-limit`, `-limit-garbage`, `-limit-cap`, `-limit-fraction` (`0.5`: `[]`), `-series-empty`, `-no-signal-empty`, `-excludes-collection`, `-director-only`, `-notfound`, `-outside-acl`; `collection-ok`, `-none-empty-body`, `-alone-empty-body`, `-notfound`, `-outside-acl` | rules 52-57 (200 empty body recorded as `body: null` with empty-body flag) |
| `cast-ok`, `crew-ok`, `cast-empty`, `cast-notfound`, `cast-outside-acl` | rule 58 |
| `streams-ok` (engine up), `streams-engine-down` (`[]`), `streams-file-of-other-media` (404), `streams-notfound-media`, `streams-badid`, `streams-library-no-path` (400 or 404) | rules 59-61 |
| `search-vector-trigger` (Rust test, not parity): insert/update `title`/`overview` through SQL and assert `searchVector` equals the rule 62 expression; the backfill migration leaves `updatedAt` unchanged | rule 63 |

## Open questions

none.
