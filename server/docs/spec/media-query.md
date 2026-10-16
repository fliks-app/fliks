# Spec: media-query (`/api/media` read routes)

Sources: `src/modules/media/media.controller.ts` (read handlers), `src/modules/media/media-service/{media-query.service,media-related.service}.ts`, `src/modules/media/media.service.ts` (façade), `src/modules/media/dto/{search-media,recently-added,calendar-query}.dto.ts`, `src/modules/media/entities/*.entity.ts`, `src/modules/media/episode-coverage.util.ts`, `src/common/constants/app-qualities.ts`, `src/common/release-parsing/quality.parser.ts`, `src/modules/media-probe/ffprobe.service.ts`, `src/modules/media/media-service/media-metadata.service.ts:1239` (search vector). Milestone: S3. Tag paths are relative to `backend/`. TypeORM behaviour was read in `node_modules/typeorm@0.3.31` (cited in prose, tags point at the Nest call site). Library ACL rules live in `libraries.md` (rules 30-36, cited "libraries rule N"); auth, CASL and error-body rules in `auth.md` ("auth rule N").

Out of scope here (stay in Nest, 35 routes of the 50 declared by `MediaController`): S5 writes `POST /api/media`, `POST /api/media/import`, `POST /api/media/import/tmdb`, `PATCH /api/media/bulk`, `PATCH /api/media/seasons/:seasonId`, `PATCH /api/media/episodes/:episodeId`, `PUT|DELETE /api/media/:id`, `DELETE /api/media/:id/files/:fileId`, `PATCH /api/media/:id/{library,profiles}`, `POST /api/media/:id/{identify,refresh,rescan,analyze}`, `POST /api/media/:id/episodes/:episodeId/refresh`, the four companions routes (`GET .../companions`, `GET .../companions/download`, `POST .../companions/edl`, `DELETE .../companions`) = 20; S6 the 14 `/api/media/:id/subtitles*` routes and `GET /api/media/sync-queue` = 15. Their ACL (`assertMediaAccessible`) keeps using the Nest copy until S5 (libraries rule 36). Release-quality subset: rules 69-70.

## Routes

15 routes. Manifest proof: `jq '[.[]|select(.path|test("^/api/media($|/)"))]|length'` = 50; `jq '[.[]|select(.method=="GET" and (.path|test("^/api/media(/(recently-added|counts|counts-by-library|qualities|genres|collections|calendar|:id|:id/(tracking|similar|collection|cast|crew|streams/:mediaFileId)))?$")))]|length'` = 15; 15 + 20 + 15 = 50.

Class level: `@Controller('media')`, `@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)` `[ts:src/modules/media/media.controller.ts:62-63]`; every route below carries `@CheckPolicies((ability) => ability.can(Action.Read, Media))` = permission `media.read` or `manage:all` (auth rules 20, 25); no `SessionTokenGuard`, no `@HttpCode` (all 200). Failure shapes: 401 (auth rule 14), 403 `Forbidden resource` (auth rule 27), 404 `{"message":"Media #<id> not found","error":"Not Found","statusCode":404}` (auth rule 15). **F8**: a `scope:'stream'` token is accepted today (auth rule 12); the Rust extractor answers 401 on all 15 (none is a stream-allowed delivery route). Declaration order: the literal GET routes (`recently-added`, `counts`, `counts-by-library`, `qualities`, `genres`, `collections`, `calendar`, `sync-queue`) win over `:id`; Rust gets this from axum's literal-over-param matching, no ordering needed, **except** `GET /api/media/sync-queue`, which stays in Nest until S6: axum would route it to the Rust `GET /api/media/{id}` (400), so Rust registers `/api/media/sync-queue` as an explicit forward to Nest (the other Nest-owned `/api/media/*` paths either use another method on a Rust path, which the method fallback forwards, or match no Rust route). `:id` and `:mediaFileId` are `ParseIntPipe` (rule 3).

`MLI` = media list item (rule 30), `MD` = media detail (rule 31), `RI` = related item (rule 55).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/media` `[ts:src/modules/media/media.controller.ts:119-125]` | `JwtOrApiKeyGuard`, `PoliciesGuard`; `Read Media` | query `SearchMediaDto` (rules 4-8): `q, type, status, monitored, year, genre, genres, yearMin, yearMax, voteMin, collectionId, qualityProfileId, languageProfileId, sortBy, sortOrder, page, limit, libraryId, missing, cutoffUnmet, unidentified, letter, excludeWatched, onlyWatched, requestedByMe`; unknown key = 400 | `{ data: MLI[], total: number }` (rules 14-29) | 400 validation (rule 4); 401; 403; numeric edge input is 400 in Rust (rule 9, C1) | none |
| `GET /api/media/recently-added` `[ts:src/modules/media/media.controller.ts:127-145]` | same | query `RecentlyAddedDto { libraryId?: number, limit?: number (default 20), mode?: 'media'\|'file'\|'both' (default 'file'), excludeWatched?: bool, requestedByMe?: bool }` | `MLI[]` **without** `watched`/`progressPercent` (rules 32-34) | 400, 401, 403, 500 on `limit < 0` (rule 9) | none |
| `GET /api/media/counts` `[ts:src/modules/media/media.controller.ts:147-153]` | same | none (query ignored) | `{ movies: number, series: number }` | 401, 403 | none |
| `GET /api/media/counts-by-library` `[ts:src/modules/media/media.controller.ts:155-161]` | same | none | `{ [libraryId: string]: number }` (rule 36) | 401, 403 | none |
| `GET /api/media/qualities` `[ts:src/modules/media/media.controller.ts:163-167]` | same | none | `QualityDefinition[]` (24 rows, rule 37), no DB access, no ACL | 401, 403 | none |
| `GET /api/media/genres` `[ts:src/modules/media/media.controller.ts:173-186]` | same | query `libraryId?: string` (not a DTO: other keys ignored, rule 38) | `{ genre: string, count: number, posters: string[] }[]` | 401, 403 | none |
| `GET /api/media/collections` `[ts:src/modules/media/media.controller.ts:188-201]` | same | query `libraryId?: string` (rule 38) | `{ id: number, name: string, count: number, posters: string[] }[]` | 401, 403 | none |
| `GET /api/media/calendar` `[ts:src/modules/media/media.controller.ts:203-209]` | same | query `CalendarQueryDto { start?: ISO-8601, end?: ISO-8601, type?: 'movie'\|'series', monitoredOnly?: bool, requestedByMe?: bool }` | `CalendarEntry[]` (rules 47-51) | 400, 401, 403, 500 on a date Postgres rejects (rule 9) | none |
| `GET /api/media/:id/tracking` `[ts:src/modules/media/media.controller.ts:217-225]` | same | path `id` int | `TrackingStatus` (rules 43-46) | 400 `Validation failed (numeric string is expected)`; 404 `Media #<id> not found`; 401; 403 | none |
| `GET /api/media/:id` `[ts:src/modules/media/media.controller.ts:887-897]` | same | path `id` int | `MD` (rule 31) | 400; 404 `Media #<id> not found`; 401; 403 | none |
| `GET /api/media/:id/similar` `[ts:src/modules/media/media.controller.ts:899-912]` | same | path `id`; query `limit?: string` (not a DTO, rule 53) | `RI[]` (rules 52-56) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/collection` `[ts:src/modules/media/media.controller.ts:914-922]` | same | path `id` | `{ id: number, name: string, items: RI[] }` or **200 with an empty body** (rule 57) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/cast` `[ts:src/modules/media/media.controller.ts:924-932]` | same | path `id` | `MediaCast[]` (rule 58) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/crew` `[ts:src/modules/media/media.controller.ts:934-942]` | same | path `id` | `MediaCrew[]` (rule 58) | 400; 404; 401; 403 | none |
| `GET /api/media/:id/streams/:mediaFileId` `[ts:src/modules/media/media.controller.ts:836-851]` | same | path `id`, `mediaFileId` int | `{ streamIndex: number, type: 'audio'\|'subtitle', codec: string, language: string, title?: string }[]` (rules 59-61) | 400; 404 `Media #<id> not found` / `MediaFile #<id> not found`; 400 or 404 (never 500) when the library has no path (rule 60, Q1); 401; 403 | engine `POST /v1/probe` (read-only) |

## Rules

### A. Auth, parameters, validation

1. Authorization is `media.read` (or `manage:all`) on every route; the per-object check is the library ACL (section B), not CASL conditions. `GET /api/media/qualities` has no object and no ACL. `[ts:src/modules/media/media.controller.ts:119-942]`
2. `request.user` is always a real user (`JwtOrApiKeyGuard` is the JWT guard only, `auth.md` guard note), so `user?.id` is always defined and every user-scoped option (`excludeWatched`, `requestedByMe`, watched/progress) applies. `[ts:src/modules/auth/guards/jwt-or-api-key.guard.ts:6-11]`
3. `:id` / `:mediaFileId` (`id: number` + `ParseIntPipe`): the global `ValidationPipe` (`transform: true`) runs first and, the param type being `Number`, applies `+value` (`transformPrimitive`); `ParseIntPipe` then tests `/^-?\d+$/` on that number's string form. So `abc`, `1.5`, `1e21`, `Infinity` = 400 `{"statusCode":400,"message":"Validation failed (numeric string is expected)","error":"Bad Request"}`, but ` 7 ` (`%207%20`), `1e1`, `0x10`, `0b11`, `+7`, `007` are accepted as 7, 10, 16, 3, 7, 7 and `%20` as 0 (404); `-5` passes and 404s; values beyond int4 (`99999999999`) hit a Postgres range error (500). Rust uses the shared `PathParams<i32>` (`server/crates/server/src/http/validate.rs`): non-decimal forms and out-of-int4 values are 400 with the same body (C1 for the 500s; the forms Nest accepts are Q2). Guards run before the pipe (auth rule 17). `[ts:src/modules/media/media.controller.ts:887-897]` (`node_modules/@nestjs/common/pipes/validation.pipe.js:123-153`, `parse-int.pipe.js:33-50`)
4. Query strings are parsed by Express 5's default `simple` parser (`node:querystring`): a repeated key becomes an array, `a=` is `''`, a bare key is `''`, `+` decodes to space, no bracket syntax (`genres[]=x` is an unknown key). The global `TolerantValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) applies to the three DTO routes only (`GET /api/media`, `recently-added`, `calendar`): an unknown key = 400 `{"message":["property <k> should not exist"],"error":"Bad Request","statusCode":400}`. Routes reading `@Query('libraryId')` / `@Query('limit')` as bare strings ignore every other key. `[ts:src/main.ts:73-79]`, `[ts:src/modules/media/dto/search-media.dto.ts:11-150]`
5. Coercions (explicit, the pipe has no implicit conversion, auth rule 16): `@Type(() => Number)` on `year, yearMin, yearMax, voteMin, collectionId, qualityProfileId, languageProfileId, page, limit, libraryId` (and `libraryId, limit` of `RecentlyAddedDto`): `Number(string)`, so `''` becomes `0`, `'1e3'` 1000, `'0x10'` 16, `' 7 '` 7; `IsNumber` then rejects `NaN`/`Infinity` (400 `<k> must be a number conforming to the specified constraints`); an array value (`year=1&year=2`) becomes an array of numbers, which `IsNumber` rejects with the same 400. Booleans (`monitored, missing, cutoffUnmet, unidentified, excludeWatched, onlyWatched, requestedByMe, monitoredOnly`): `@Transform(({value}) => value === 'true' || value === true)`: **only the exact string `true` is true**; `TRUE`, `1`, `yes`, `''`, an array are all `false` and never fail validation. `[ts:src/modules/media/dto/search-media.dto.ts:18-150]`
6. Strings: `q, genre, sortBy, sortOrder, letter` are `IsString` (an array = 400 `<k> must be a string`); `sortOrder` is typed `'ASC'|'DESC'` but not validated as an enum. Enums: `type` ∈ `movie|series` (400 `type must be one of the following values: movie, series`), `status` ∈ `tba|announced|released|ended|continuing|deleted`, `mode` ∈ `media|file|both`; `IsOptional` skips only `undefined`/`null`, so `?type=` (empty) is 400. `[ts:src/modules/media/dto/search-media.dto.ts:11-26]`, `[ts:src/common/enums/media-status.enum.ts:1-8]`, `[ts:src/modules/media/dto/recently-added.dto.ts:20-23]`
7. `genres`: `IsArray` + `IsString({each})` after a `@Transform`: an array value is mapped to trimmed strings with empty ones dropped; a string is split on `,`, each part trimmed, empties dropped (`?genres=` gives `[]`); `genres=a,b` and `genres=a&genres=b` are equivalent. `[ts:src/modules/media/dto/search-media.dto.ts:36-54]`
8. `CalendarQueryDto.start|end`: `IsDateString` = validator.js `isISO8601` non-strict (`2026-03-01`, `2026-03-01T10:00:00Z`, `20260301`, week dates all pass); only the first 10 characters are used (rule 47). `[ts:src/modules/media/dto/calendar-query.dto.ts:6-13]`
9. Numeric inputs the DTO lets through and Postgres rejects are **500 today**: non-integer or out-of-int4 `year, yearMin, yearMax, qualityProfileId, languageProfileId, collectionId, libraryId` (`invalid input syntax for type integer` / `out of range`), `page < 1` **with `limit > 0`** (negative `OFFSET`; with `limit <= 0` there is no `OFFSET` and `page` is ignored, 200), `limit < 0` on `recently-added` (negative `LIMIT`), `page`/`limit` whose `LIMIT`/`OFFSET` literal leaves int8 (`1e20`) or prints in exponent form (`1e21` → `LIMIT 1e+21`), calendar dates Postgres cannot parse (rule 47), `sortBy` naming an `Object.prototype` member (rule 17). TypeORM inlines `LIMIT`/`OFFSET` as JS number text and Postgres rounds a numeric literal half away from zero (`LIMIT 2.5 OFFSET 2.5` returns rows 4-6, `LIMIT 0.4` none; checked on PG 18), so fractional `page`/`limit` succeed and Rust rounds the same way. A `q` word longer than 2047 characters is **not** an error: `to_tsquery` drops it with a NOTICE. Rust answers 400 with the standard validation body (C1 extended, rule 71); scenarios for these inputs are recorded with `deviation: "C1"`. `[ts:src/modules/media/media-service/media-query.service.ts:203-262]` (TypeORM `SelectQueryBuilder.js:1355-1432`)
10. A handler returning `null`/`undefined` answers **200 with an empty body** (`res.send()`, no `Content-Type`), not JSON `null`; `[]` and `{}` are JSON. Only `GET :id/collection` returns `null` (rule 57). `[ts:src/modules/media/media-service/media-related.service.ts:191-210]`

### B. Library ACL

11. Every route except `qualities` computes `ids = getAccessibleLibraryIds(user)` once (libraries rule 30: every `libraries.id` for `isAdmin`/`manage:all`, else the `library_user_access` rows of the user; no order). Per-media routes then run `assertAccessible(:id, ids)` first (libraries rule 32): no row, `libraryId IS NULL` (also for admins) or `libraryId` not in `ids` = 404 `Media #<id> not found` (same body for missing and denied). Rust: one `accessible_library_ids` + one `assert_media_accessible` (libraries rule 34), `"libraryId" = ANY($ids)`. `[ts:src/modules/media/media.controller.ts:81-88]`, `[ts:src/modules/media/media-service/media-query.service.ts:585-603]`
12. Empty `ids`: list = `{ data: [], total: 0 }` (Nest appends `1 = 0`), `recently-added` = `[]`, `counts` = `{ movies: 0, series: 0 }`, `counts-by-library` = `{}`, `genres` / `collections` = `[]` (early return), `calendar` = `[]`. Rust short-circuits to the same bodies. Media with `libraryId IS NULL` match no ACL clause and never appear in any list, count or calendar. `[ts:src/modules/media/media-service/media-query.service.ts:106-135]`, `[ts:src/modules/media/media-service/media-query.service.ts:984-1002]`
13. Any `libraryId` filter (list, recently-added, genres, collections) narrows **inside** the ACL (AND), never widens it. Per-media routes check only the target media; `similar` and `collection` candidates are restricted to the source media's library (accessible because the source passed the gate), `cast`/`crew` persons carry no ACL. `[ts:src/modules/media/media-service/media-related.service.ts:117-215]`

### C. `GET /api/media` (list)

14. Defaults and pagination: `page = query.page ?? 1`, `limit = query.limit ?? 25`, `offset = (page - 1) * limit`; pagination applies only when `limit > 0` (`limit <= 0`, including `0` and negatives, returns **every** matching row and `total` of the same set). There is no upper bound on `limit`. `[ts:src/modules/media/media-service/media-query.service.ts:208-210]`, `[ts:src/modules/media/media-service/media-query.service.ts:255-257]`
15. Query shape: `FROM media` with LEFT JOINs `library`, `qualityProfile`, `languageProfile`, `files` (`media_files` on `"mediaId"`), then ACL (`"libraryId" IN ids`), then `applyFilters`, then the user-scoped clauses, then FTS, then the sort. All clauses are ANDed. `[ts:src/modules/media/media-service/media-query.service.ts:212-220]`
16. **Parent-id pagination (plan §6.1)**: `getManyAndCount` with `skip/take` over a query that joins `files` makes TypeORM run (a) `SELECT DISTINCT <media id>, <sort column> FROM (<query without ORDER BY>) distinctAlias ORDER BY <sort col> <dir>, <media id> ASC LIMIT take OFFSET skip` (the id tie-break is **always ASC**, whatever `sortOrder`), (b) the same query again with `AND media.id IN (<those ids>)` and the user `ORDER BY` only (no `LIMIT`), entities grouped by id in first-appearance order, (c) `SELECT COUNT(DISTINCT(media.id))` over the unpaginated query. Rust: page `SELECT media.id ... ORDER BY <col> <dir>, media.id ASC LIMIT/OFFSET`, `COUNT(*)` over the same `WHERE` (no duplicates exist once `files` is an `EXISTS`, rule 22), hydrate in the page order. Page **membership** is deterministic in Nest; the order **inside** a page among rows with equal sort keys is not (phase b has no tie-break), Rust uses `id ASC` (C12). `[ts:src/modules/media/media-service/media-query.service.ts:259]` (TypeORM `SelectQueryBuilder.js:1992-2025`, `computeCountExpression`)
17. Sort: `sortBy` is looked up in `{ title: media.title, year: media.year, added: media."createdAt", createdAt: media."createdAt", rating: media.rating }`; any other value (including `''`, `Title`, SQL text) silently falls back to `title`; default `title`. Exception: the lookup is a plain object, so a `sortBy` naming an `Object.prototype` member (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) yields a function, which TypeORM turns into `ORDER BY function …() { [native code] }` (500), and `__proto__` yields an object with no keys (no `ORDER BY` at all); Rust treats them as unknown keys (`title`, C1). `sortOrder`: `DESC` only when exactly the string `DESC`, otherwise `ASC` (`desc`, `Desc`, junk all give ASC). No `NULLS` clause: Postgres defaults apply (`ASC` nulls last, `DESC` nulls first), so `year`/`rating` NULLs sort last ascending. Text and `title` ordering is Postgres' own (database default collation, case/accent rules of the DB), never done in Rust. `[ts:src/modules/media/media-service/media-query.service.ts:244-253]`
18. `q` replaces nothing in the order: FTS adds `orderBy('rank', 'DESC')` first, but the sort of rule 17 is applied afterwards with `qb.orderBy(...)`, which **replaces** all previous order-bys (TypeORM `orderBy` assigns, `addOrderBy` appends), so FTS results are ordered by the requested sort (default `title ASC`), never by relevance. The selected `ts_rank` column is not part of the response. Nest only: Rust orders by rank when `sortBy` is absent (C10, rule 67). `[ts:src/modules/media/media-service/media-query.service.ts:1113]`, `[ts:src/modules/media/media-service/media-query.service.ts:1123]`, `[ts:src/modules/media/media-service/media-query.service.ts:253]`
19. Filters, `applyFilters` (each only when its guard holds; the table is exhaustive; param types are the SQL column types, `enum` = `media_type_enum` / `media_status_enum`):

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
    | `collectionId` | truthy | `media."tmdbCollectionId" = $n` | |
    | `qualityProfileId` | truthy | `media."qualityProfileId" = $n` | |
    | `languageProfileId` | truthy | `media."languageProfileId" = $n` | |
    | `missing` | `!== undefined` | rule 22 | |
    | `unidentified` | `=== true` | `media."tmdbId" IS NULL AND media."tvdbId" IS NULL AND media."imdbId" IS NULL` | an `imdbId` of `''` counts as identified |
    | `letter` | truthy | rule 23 | |

    `[ts:src/modules/media/media-service/media-query.service.ts:1004-1091]`, `[ts:src/modules/media/media-service/media-query.service.ts:1008-1090]`
20. User-scoped clauses (only with a user, always true): `(excludeWatched || onlyWatched)` adds `media.id <op> (<watched subquery>)` with `op = onlyWatched ? IN : NOT IN` (so `onlyWatched` wins when both are set); `requestedByMe` adds `media."addedById" = $user` (approved requests and direct imports both set `addedById`). The watched subquery is the verbatim SQL of Q-W below: a movie is watched when any `playback_states` row of the user for it is `completed`; a series when it has at least one episode with a file in a season `> 0` and **every** such episode has a completed row of the user (specials excluded; a series with no file-backed episodes is never watched). `[ts:src/modules/media/media-service/media-query.service.ts:222-232]`, `[ts:src/modules/media/media-service/media-query.service.ts:55-86]`
21. `getManyAndCount` returns `total` = number of distinct media matching all clauses above (not reduced by `cutoffUnmet`, rule 26, nor by `limit`). `[ts:src/modules/media/media-service/media-query.service.ts:259]`
22. `missing` (rule 19) is, with `today` = the **UTC** date `YYYY-MM-DD` computed in application code (not `CURRENT_DATE`): `missing=true` → `(files.id IS NULL OR <ME>)`, `missing=false` → `(files.id IS NOT NULL AND NOT <ME>)`, where `files.id IS NULL` means the media has no `media_files` row (Rust: `NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = media.id)`) and `<ME>` is Q-M below ("a monitored season (> 0) holds a monitored episode, aired on or before today, not on disk"). An episode with `airDate IS NULL` is never missing; an unmonitored series with gaps is still missing; a movie is missing iff it has no file. "On disk" (coverage) = own `hasFile` or covered by the `[episodeNumber+1 .. endEpisodeNumber]` range of a sibling episode in the same season that has a file. `[ts:src/modules/media/media-service/media-query.service.ts:1061-1077]`, `[ts:src/modules/media/episode-coverage.util.ts:73-83]`
23. `letter`: `letter = query.letter.toUpperCase()` (JS Unicode upper-casing); `'#'` → `media.title !~ '^[A-Za-z]'` (title not starting with an ASCII letter, evaluated by Postgres); a single ASCII `A`-`Z` → `UPPER(LEFT(media.title, 1)) = $letter` (database `UPPER`; titles starting with an accented letter do not match their base letter); anything else (two characters, `1`, `É`, lowercase that does not upper-case into `A-Z`) adds **no filter** and no error. `[ts:src/modules/media/media-service/media-query.service.ts:1083-1090]`
24. **Full-text search** (`q` truthy; `''` = no search; whitespace-only is truthy): 
    - Prefix tsquery: `q.trim().split(/\s+/)` (JS whitespace set), each word stripped of every character that is not `\p{L}` or `\p{N}` (Unicode flag), empty results dropped, each remaining word suffixed `:*`, joined with ` & ` → `$tsq` (`star wars` → `star:* & wars:*`). Rust must use the `regex` crate classes `\p{L}`/`\p{N}` and the JS whitespace set (it includes U+FEFF, excludes U+0085), not `char::is_alphabetic`/`split_whitespace`.
    - `<TSQ>` = `to_tsquery('french', $tsq)` when `$tsq` is non-empty, else `plainto_tsquery('french', $q)` (which yields an empty query for symbol-only input: the `@@` branch is then false and only the ILIKE/similarity branches can match). Text-search configuration is **`french`** (not `simple`), no `websearch_to_tsquery`; stop words drop out of the query inside Postgres.
    - Predicate: `( media."searchVector" @@ <TSQ> OR media.title ILIKE $like OR media."originalTitle" ILIKE $like OR similarity(media.title, $q) > 0.8 )` with `$q` the **untrimmed** raw `q`, `$like = '%' || q || '%'` unescaped (a user `%`, `_` or `\` keeps its LIKE meaning), `similarity` from `pg_trgm` (migration `1786400000000_pg_trgm.sql`). `searchVector` is NULL for a row never indexed: only the other three branches can match it.
    - No relevance order in Nest (rule 18); Rust orders by rank when `sortBy` is absent (C10, rule 67). `[ts:src/modules/media/media-service/media-query.service.ts:1093-1124]`
25. `attachEpisodeStats` runs on the page: `sizeOnDisk = Σ Number(file.size)` over the loaded `files` (number, `0` when none); for series, one query (Q-S below, `"downloaded"` counts coverage on disk, season 0 excluded) gives `episodeStats: { totalEpisodes: number, downloadedEpisodes: number }`, **absent** (key omitted) for movies and for series without episodes in seasons `> 0`. `[ts:src/modules/media/media-service/media-query.service.ts:427-468]`
26. `cutoffUnmet === true` is a **post-filter on the already paginated page** (items are removed from `data`, `total` is untouched, a page can hold fewer than `limit` items). A media is kept only if it has a quality profile whose `cutoff` id resolves in the quality table (`cutoffRank`; no profile or unknown id = dropped). Movies: kept when the best `rankFromQualityString(file.quality)` over `files` (0 with none) is `< cutoffRank`. Series: one query (Q-C below) returns, per monitored episode of seasons `> 0`, the best file rank (`rankFromQualityString`, 0 for no file or empty quality); a series with no such episodes is dropped; `shadowedEpisodeNumbers` is computed over **all** those episodes of the media pooled across seasons (a multi-episode range in season 1 also shadows the same numbers in season 2: quirk, frozen); kept when some non-shadowed episode has `rank < cutoffRank`. `rankFromQualityString` = `0` for null/empty else `parseReleaseQuality(q).quality.rank` (quality parser ported in S3, rule 69). Nest only: Rust filters in SQL before pagination (C11, rule 68). `[ts:src/modules/media/media-service/media-query.service.ts:263-357]`, `[ts:src/common/release-scoring/release-rejection.helper.ts:53-58]`, `[ts:src/modules/media/episode-coverage.util.ts:55-66]`
27. `attachWatchedProgress` runs last on the (post-cutoff) page: for each media `watched: boolean` (`=== true`) and `progressPercent: number` from the verbatim SQL of Q-P: movies resume % = `ROUND(positionSeconds / durationSeconds * 100)::int` of the **most recent** incomplete whole-media row (`episodeId IS NULL`, `completed = false`, `durationSeconds > 0`, `ORDER BY "lastPlayedAt" DESC LIMIT 1`), `0` otherwise and always `0` for series; `watched` uses the same definition as rule 20. The percentage stays in SQL: `positionSeconds`/`durationSeconds` are `float8` and `round(float8)` rounds half to even (`450/3600` gives 12, not 13), unlike Rust's `f64::round`. `[ts:src/modules/media/media-service/media-query.service.ts:359]`, `[ts:src/modules/media/media-service/media-query.service.ts:370-420]`
28. Response `{ data, total }` is a plain object holding entity instances; the global `ClassSerializerInterceptor` serialises them (rule 30). `[ts:src/main.ts:83-86]`
29. Rust must run, per request: ACL ids; page ids; count; hydrate (media + the three many-to-one joins + `files` by `ANY(ids)` ordered `id ASC`, rule 30); episode stats; cutoff queries only when requested; watched/progress. `[assumed]` on the order of `files` (Nest has no `ORDER BY` there; heap order is `id` order in practice).

### D. Entity shapes (list and detail)

30. `MLI` (list and `recently-added` item) = the `Media` entity as a plain JSON object:
    - all `media` columns **except** `searchVector` (`select: false`): `id, createdAt, updatedAt` (ISO `%Y-%m-%dT%H:%M:%S%.3fZ`), `title, originalTitle` (string\|null), `alternativeTitles` (string[]), `year` (int\|null), `type`, `tmdbId, imdbId, tvdbId` (\|null), `overview`, `status`, `monitored`, `preferredProvider`, `folderName`, `posterUrl, fanartUrl, logoUrl` (\|null), `additionalFanartUrls` (string[]), `metadataRefreshedAt` (ISO\|null), `rating` (float\|null), `genres` (string[]\|null), `tmdbCollectionId, tmdbCollectionName, runtime`, `releaseDate, inCinemas, digitalRelease, physicalRelease` (`YYYY-MM-DD` strings\|null), `minimumAvailability`; nullable columns are present as `null`;
    - `path`: `@Expose` getter, `null` unless `library.path` is truthy; when `folderName` is truthy `path.join(library.path, folderName)` (POSIX normalisation: `//` collapsed, `.`/`..` resolved), else `library.path` verbatim;
    - relation-id fields `libraryId, qualityProfileId, languageProfileId, addedById`: **present only when the foreign key is non-null, otherwise the key is absent** (TypeORM sets an id only when one exists);
    - joined relations: `library` (object\|null: all `libraries` columns + `defaultQualityProfileId`/`defaultLanguageProfileId` when non-null), `qualityProfile` (object\|null: `id, createdAt, updatedAt, name, cutoff, items, upgradeAllowed, resolutionUpgradeOnly, minCustomFormatScore`), `languageProfile` (object\|null: `id, createdAt, updatedAt, name, audioLanguages, subtitleLanguages`), `files` (array, `[]` when none): `id, createdAt, updatedAt, relativePath, size` (**JSON number**, transformer `Number(v)`), `quality` (string), `language` (string\|null), `streamInfo` (jsonb\|null, returned whole), `osdbHash` (string\|null, varchar 16), `osdbBytesize` (**number**\|null, bigint with transformer), `mediaId` (always), `episodeId` (only when non-null);
    - derived: `sizeOnDisk`, `episodeStats?` (rule 25), `watched`, `progressPercent` (rule 27; absent on `recently-added`);
    - **not present**: `metadata`, `seasons`, `cast`, `crew`, `addedBy`, `searchVector` (query-builder reads do not load eager relations).
    `[ts:src/modules/media/entities/media.entity.ts:26-229]`, `[ts:src/modules/media/entities/media-file.entity.ts:13-67]`, `[ts:src/modules/profiles/entities/quality-profile.entity.ts:5-33]`, `[ts:src/modules/libraries/entities/library.entity.ts:18-69]`. The relation-id presence rule is read from TypeORM 0.3.31 `RawSqlResultsToEntityTransformer.transformRelationIds` (`if (idMaps[0] !== undefined)`); the first parity recording must confirm key presence for `libraryId`, `files[].episodeId` and `library.defaultQualityProfileId` `[assumed]`.
31. `MD` (`GET :id`) = `findOne` with `relationLoadStrategy: 'query'` and relations `seasons, seasons.episodes, files, qualityProfile, languageProfile, library, metadata`: the `MLI` columns/`path`/relation ids/joined relations of rule 30 **plus** `seasons` (array, `[]` when none; each `id, createdAt, updatedAt, seasonNumber, monitored, preferredProvider, posterUrl, overview, airDate` (string\|null, varchar), `mediaId`, `episodes[]`) and `metadata`; **no** `sizeOnDisk`, `episodeStats`, `watched`, `progressPercent`. Episode: `id, createdAt, updatedAt, episodeNumber, endEpisodeNumber, title, overview, airDate` (`YYYY-MM-DD`\|null), `runtime, monitored, hasFile, stillUrl, markersScannedAt` (ISO\|null), `seasonId` (no `searchVector`). `metadata` (`media_metadata`): `id, createdAt, updatedAt, budget, revenue` (**strings** or null: bigint without transformer, plan §6.1), `tagline, popularity` (float), `voteCount, originalLanguage, productionCountries, productionCompanies, videos, keywords` (jsonb); when the media has no metadata row the key is `null` `[assumed]` (parity: base seed has none, first recording confirms). `[ts:src/modules/media/media-service/media-query.service.ts:637-686]`, `[ts:src/modules/media/entities/media-metadata.entity.ts:5-40]`, `[ts:src/modules/media/entities/season.entity.ts:14-53]`, `[ts:src/modules/media/entities/episode.entity.ts:13-75]`
32. `findOne` post-processing: seasons sorted with `seasonNumber 0` (specials) **last**, the others ascending; episodes of each season ascending by `episodeNumber`; for series, any episode whose id appears as `episodeId > 0` of a loaded file gets `hasFile = true` in the response even if the column says `false`. 404 `Media #<id> not found` when the row vanished after the gate. `files` have no ORDER BY in Nest (Rust: `id ASC`). `[ts:src/modules/media/media-service/media-query.service.ts:658-685]`
33. `recently-added` (`findRecentlyAdded`): limit `query.limit ?? 20` (`0` gives `[]` via `LIMIT 0`; negative = 500, rule 9), mode `query.mode ?? 'file'`, user clauses only when `excludeWatched || requestedByMe`. Pass 1 ranks ids with Q-R below, pass 2 loads the full `MLI` (library, profiles, files joins, `id IN ids`), restores the pass-1 order and runs `attachEpisodeStats` only. Mode `media`: `ORDER BY media."createdAt" DESC`; `file`: only media with a file, `ORDER BY lf.added DESC` (newest `media_files."createdAt"` per media); `both`: `ORDER BY GREATEST(media."createdAt", COALESCE(lf.added, media."createdAt")) DESC`. No tie-break (Rust adds `media.id ASC`, C12). `libraryId` (truthy) is ANDed with the ACL. `[ts:src/modules/media/media-service/media-query.service.ts:482-560]`
34. `recently-added` items carry no `watched` / `progressPercent` (`attachWatchedProgress` is not called); `excludeWatched` filters with `media.id NOT IN (<watched subquery>)` (no `onlyWatched` here). `[ts:src/modules/media/media-service/media-query.service.ts:559]`

### E. Counts, genres, collections, qualities

35. `counts`: two counts over `media` (`type = 'movie'`, `type = 'series'`) with the ACL clause; numbers. `[ts:src/modules/media/media-service/media-query.service.ts:106-121]`
36. `counts-by-library`: `SELECT m."libraryId", COUNT(*)::int FROM media m WHERE m."libraryId" IS NOT NULL AND m."libraryId" IN ids GROUP BY m."libraryId"` → `Object.fromEntries`: JSON object keyed by the library id as a string, libraries without media absent, keys in ascending numeric order (JS integer-key order: a `BTreeMap<String, _>` would put `10` before `2`). This method stays in Nest (used by `/api/counts`, S8). `[ts:src/modules/media/media-service/media-query.service.ts:123-135]`
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

    The Rust constant must serialise to the same JSON as the TS array (golden fixture `app-qualities`, Vectors). `[ts:src/common/constants/app-qualities.ts:12-49]`
38. `genres` and `collections`: `libraryIdRaw` handling: `libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null`; when truthy and finite the scope is `[libraryId]` if it is in `ids`, else `[]`; `''`, `0`, `NaN` (`abc`) leave the scope at `ids`; `12abc` parses to 12; a repeated key (`libraryId=1&libraryId=2`) is an array that the global pipe turns into `String(['1','2'])` = `'1,2'` (`string`-typed param), so `parseInt` gives 1. Empty scope returns `[]` without SQL. `genres` = Q-G (one row per distinct genre string, **case-sensitive**, ordered `genre ASC` by database collation; `count` counts occurrences, so a genre repeated inside one media's array counts twice; `posters` = up to 4 non-null `posterUrl`s ordered by `media.id`, `[]` when none). `collections` = Q-K (only collections with `COUNT(*) >= 2` within the scope; grouped by `(tmdbCollectionId, tmdbCollectionName)`, ordered by name `ASC`, equal names unordered: Rust adds `, id ASC`, C12). `[ts:src/modules/media/media.controller.ts:173-201]`, `[ts:src/modules/media/media-service/media-query.service.ts:144-201]`

### F. Tracking

39. `getTrackingStatus(id)`: `findOne(id)` (rule 32), `profile = media.qualityProfile`, `cutoffDef = getAppQualityById(profile.cutoff)` (undefined for no profile or unknown id), `targetQuality = label(cutoffDef)` where `label(def) = def.resolution > 0 ? '<resolution>p' : def.name`. `[ts:src/modules/media/media-service/media-query.service.ts:694-702]`
40. `stateOf(monitored, files)` (each `files` item has `quality`): not monitored → `{ monitored, state: 'unmonitored' }`; no `cutoffDef` → `{ monitored, state: 'no-profile' }`; no files → `{ monitored, state: 'missing' }`; else `best` = highest-`rank` `parseReleaseQuality(file.quality).quality` (first wins on equal rank); `best.rank >= cutoffDef.rank` → `{ monitored, state: 'met', currentQuality: label(best) }`; else `sameResolution = best.resolution === cutoffDef.resolution` and `{ monitored, state: 'below', currentQuality: sameResolution ? best.name : label(best), targetQuality: sameResolution ? cutoffDef.name : targetQuality }`. Absent keys are omitted (undefined). `stateOf` calls `parseReleaseQuality` directly, so an empty `quality` string parses to `Bluray-480p` (rank 30) here while `rankFromQualityString('')` is 0 in `cutoffUnmet` (rule 26): frozen. `[ts:src/modules/media/media-service/media-query.service.ts:704-743]`
41. Movie: `{ type: 'movie', hasProfile: !!profile, movie: stateOf(media.monitored, media.files) }` (all files of the media). `[ts:src/modules/media/media-service/media-query.service.ts:745-751]`
42. Series: `{ type: 'series', hasProfile: !!profile, seasons: [{ seasonNumber, episodes: TrackingEpisode[] }] }`: seasons in `findOne` order (specials last, seasons without episodes listed with `episodes: []`); files are grouped by `episodeId` (files with a null `episodeId` ignored); an episode is **hidden** when its number lies in `(episodeNumber, endEpisodeNumber]` of another episode of the same season (range only, independent of `hasFile`); each visible episode is `{ episodeId: id, seasonNumber, episodeNumber, endEpisodeNumber: endEpisodeNumber ?? null, title (string\|null), ...stateOf(episode.monitored, filesOfEpisode) }`. `hasProfile` is true even when the cutoff id is unknown (state then `no-profile`). The media's own `monitored` is not consulted for series. `[ts:src/modules/media/media-service/media-query.service.ts:753-787]`
43. `hasProfile`, `state` ∈ `unmonitored|no-profile|missing|below|met` are client-matched strings. `[ts:src/modules/media/media-service/media-query.service.ts:21-53]`
44. `parseReleaseQuality` and `getAppQualityById` are needed in S3 (`tracking`, `cutoffUnmet`) although plan §10 ports `release-parsing` at S5: the subset is ported in S3 (rule 69). Behaviour to port: `quality.parser.ts:19-117` (lower-cased, `.` replaced by space, source/resolution regexes, candidate selection, fuzzy fallback; a resolution with no table bucket (`4320p`/`8K`, `576p`, `360p`) leaves the fuzzy list empty and returns **`WORKPRINT`** (id 1, rank 5, resolution 0) as `quality`, with a display-only label `<res>p (<nearest>)` (`4320p (HDTV-2160p)`, `576p (DVD)`) that neither `tracking` nor `cutoffUnmet` reads; the source comment claiming the quality is "left off the table" does not match the code). `[ts:src/common/release-parsing/quality.parser.ts:19-117]`
45. Neither `tracking` nor `findOne` is cached; both are recomputed per request. `[assumed]` (no cache found in the service).
46. `TrackingEpisode.title` comes from `episodes.title` (nullable). `[ts:src/modules/media/media-service/media-query.service.ts:37-44]`

### G. Calendar

47. Window: both `start` and `end` given → each `.slice(0, 10)`; otherwise (including only one of them) the **current month in the server's local time zone** (`new Date()` local getters: first day to `new Date(y, m+1, 0).getDate()`; Rust uses the process local zone, not UTC). The sliced strings go to Postgres unparsed (`BETWEEN :start AND :end` against `date` columns), so what Postgres accepts decides: `2026-03-01`, compact `20260301`, ordinal `2026-060` work; `2026-03`, `2026`, `2026031`, week dates and `2026-02-30` pass the DTO (rule 8) but are a Postgres error (500, rule 9; Rust 400, C1). Rust binds the same raw strings as text cast to `date` in SQL and maps that cast error to 400; it does not reformat them (rule 48 compares the raw strings). `[ts:src/modules/media/media-service/media-query.service.ts:815-826]`
48. Movies (when `type` unset or `movie`): `m.type = 'movie' AND (m.inCinemas BETWEEN $s AND $e OR m.digitalRelease BETWEEN ... OR m.physicalRelease BETWEEN ... OR m.releaseDate BETWEEN ...)` (inclusive, `date` columns), `+ m.monitored = true` when `monitoredOnly`, `+ m."addedById" = $user` when `requestedByMe`, ACL (`1 = 0` when empty else `m."libraryId" IN ids`), with `files` left-joined (`hasFile = files.length > 0`). For each movie one entry per specific date inside the window in the order `cinema` (`inCinemas`), `digital` (`digitalRelease`), `physical` (`physicalRelease`); if **none** of the three is inside the window and `releaseDate` is, one entry `event: 'release'`. "Inside the window" is a JS **string** comparison `d >= start && d <= end` of the `YYYY-MM-DD` column value against the raw sliced `start`/`end`, not the SQL `BETWEEN`: with `start=20260301` SQL selects the movies but `'2026-03-05' < '20260301'` lexically, so no movie entry is emitted (episodes, filtered in SQL only, still are). Frozen; Rust compares the same raw strings. `[ts:src/modules/media/media-service/media-query.service.ts:848-922]`
49. Episodes (when `type` unset or `series`): `episodes ep INNER JOIN seasons season INNER JOIN media media WHERE ep."airDate" BETWEEN $s AND $e`, `+ media.monitored = true AND ep.monitored = true` when `monitoredOnly`, `+ media."addedById" = $user` when `requestedByMe`, ACL as above, `ORDER BY ep."airDate" ASC`; season 0 episodes are **included**. `hasFile` = coverage on disk (`onDiskSql('ep')`, SQL in Q-D), falling back to `ep.hasFile`. `[ts:src/modules/media/media-service/media-query.service.ts:931-977]`
50. Entry shape (undefined keys omitted): movie `{ id: media.id, mediaId: media.id, title, type: 'movie', event, date: 'YYYY-MM-DD', posterUrl, fanartUrl, status, year, hasFile }`; episode `{ id: episode.id, mediaId, title: <series title>, type: 'series', event: 'airing', date, posterUrl, fanartUrl, status, year, seasonNumber, episodeNumber, episodeTitle: episode.title, hasFile }`. `posterUrl`/`fanartUrl`/`year` may be `null`; `id` collides across kinds (the client keys on type). `[ts:src/modules/media/media-service/media-query.service.ts:827-846]`
51. Final order: `results.sort((a, b) => a.date.localeCompare(b.date))` (stable, ISO dates so plain lexical): ties keep insertion order = movies in database order (no ORDER BY; per movie cinema, digital, physical, release) then episodes in `airDate` order (equal dates unordered). Rust: movies `ORDER BY m.id`, episodes `ORDER BY ep."airDate", ep.id` (C12). `[ts:src/modules/media/media-service/media-query.service.ts:980]`

### H. Related, cast, crew

52. `GET :id/similar`: `findSimilar(id, limit)`: loads the source with `metadata`; `type !== 'movie'` or no library → `[]`; `genres = source.genres ?? []`, `keywords = metadata?.keywords ?? []`, `directors` = person ids of `media_crew` rows of the source with `job = 'Director'` (exact, case-sensitive), `sameDirectorIds` = distinct `media_crew."mediaId"` of other media with `job = 'Director'` and `"personId" IN directors` (any library; excludes the source id); no genres, no keywords and no same-director ids → `[]`. `[ts:src/modules/media/media-service/media-related.service.ts:117-133]`, `[ts:src/modules/media/media-service/media-related.service.ts:217-238]`
53. `limit` query (bare string): `Number(limit)`; finite and `> 0` → `Math.min(parsed, 30)` (fractional kept, then `Array.slice` truncates), anything else (absent, `''`, `0`, negative, `abc`) → default **12**. `[ts:src/modules/media/media.controller.ts:899-912]`, `[ts:src/modules/media/media-service/media-related.service.ts:117]`
54. Candidates (Q-X below): media with the **same library and `type = 'movie'`, `id != source`**, where `jsonb_exists_any(m.genres, <source genres>)` (exact, case-sensitive element match) **OR** `jsonb_exists_any(meta.keywords, <source keywords>)` **OR** `m.id IN sameDirectorIds` (each branch only if its list is non-empty), and, when the source has a `tmdbCollectionId`, `(m.tmdbCollectionId IS NULL OR m.tmdbCollectionId != source)` (collection mates excluded). `hasFile` = media has at least one `media_files` row. `[ts:src/modules/media/media-service/media-related.service.ts:135-168]`
55. Score (f64, evaluate in exactly this order so floats match): `score = 0`; `+= min(keywordHits * 1.6, 4.8)` where `keywordHits` = number of candidate keywords whose lower-case is in the lower-cased set of the source keywords (candidate duplicates counted); `+= cosine(sourceGenres, candidateGenres) * 2.5` where `cosine = shared / sqrt(a.length * b.length)` (0 when `shared = 0`, `shared` counted like `keywordHits`); `+= 2` when same director; when both years are truthy `+= max(0, 1 - |Δyear| / 20) * 0.5`. Keep when `score >= 1`; sort `score DESC`, then `(rating ?? 0) DESC`, **stable over the SQL row order** (unordered in Nest, Rust: `m.id ASC` first, C12); take `limit`. Item `RI` = `{ id, title, year, posterUrl: posterUrl ?? null, fanartUrl: fanartUrl ?? null, rating: rating ?? null, genres: genres ?? [], hasFile: boolean }` (`year` may be `null`). Lower-casing is JS `toLowerCase` (Unicode); Rust `str::to_lowercase`, vectors cover non-ASCII. `[ts:src/modules/media/media-service/media-related.service.ts:28-95]`, `[ts:src/modules/media/media-service/media-related.service.ts:170-185]`
56. 404 `Media #<id> not found` when the source vanished after the gate. `[ts:src/modules/media/media-service/media-related.service.ts:119-121]`
57. `GET :id/collection`: source without `tmdbCollectionId` or without library → `null` (**200, empty body**, rule 10); else every media of the **same library** with the same `tmdbCollectionId` (any `type`), `ORDER BY m."releaseDate" ASC NULLS LAST, m.year ASC NULLS LAST` (no id tie-break; Rust adds `m.id ASC`, C12), including the source itself; fewer than 2 rows → `null`; else `{ id: tmdbCollectionId, name: tmdbCollectionName ?? '', items: RI[] }`. `[ts:src/modules/media/media-service/media-related.service.ts:191-215]`
58. `cast`: `media_cast` of the media with its `person`, `ORDER BY "order" ASC` (ties unordered, Rust adds `, id ASC`); `crew`: `media_crew` with `person`, **no ORDER BY** (Rust `ORDER BY id ASC`, C12). Cast row `{ id, createdAt, updatedAt, character, order, person }`, crew row `{ id, createdAt, updatedAt, job, department, person }` (no `media` key); `person` = all `persons` columns except `searchVector`: `id, createdAt, updatedAt, provider, tmdbId, name, avatarUrl, biography, birthday, deathday` (`YYYY-MM-DD`\|null), `placeOfBirth, knownForDepartment, departments` (string[]), `metadataRefreshedAt` (ISO\|null). A media without credits gives `[]`. `[ts:src/modules/media/media-service/media-query.service.ts:622-635]`, `[ts:src/modules/media/entities/media-cast.entity.ts:7-23]`, `[ts:src/modules/media/entities/person.entity.ts:5-48]`

### I. Streams

59. `GET :id/streams/:mediaFileId`: gate (rule 11), `findOne(id)` (rule 32), `file = media.files.find(f.id === mediaFileId)`; none (including a file of another media) = 404 `MediaFile #<mediaFileId> not found`. Path = `path.join(media.path, file.relativePath)` where `media.path` is rule 30's getter; the engine probe gets `path.resolve(<that>)`. `[ts:src/modules/media/media.controller.ts:836-851]`
60. When `media.path` is null (library without `path`), `path.join(null, …)` throws a `TypeError`: **500** in Nest. Rust answers 400 or 404, never 500 (C1, rule 71; exact status Q1). `[ts:src/modules/media/media.controller.ts:846-849]`
61. Probe: engine `POST /v1/probe {media:{mediaFileId:0,path}}` through the S2 engine client (`engine-glue.md` probe row). An engine that is down, disabled, answers non-2xx or reports an error returns **`[]`** (200), never an error (`softProbe` catches). Success: `[...audio.map(s => ({...s, type:'audio'})), ...subtitles.map(s => ({...s, type:'subtitle'}))]` sorted ascending by `streamIndex` (stable: audio before subtitle on equal index), each mapped to `{ streamIndex, type, codec, language, title }` (`title` omitted when absent). `[ts:src/modules/media-probe/ffprobe.service.ts:214-229]`, `[ts:src/modules/media-probe/ffprobe.service.ts:182-193]`

### J. Search vector (plan §6.3 decision)

62. Derivation: `media."searchVector" = setweight(to_tsvector('french', COALESCE(title,'')), 'A') || setweight(to_tsvector('french', COALESCE("originalTitle",'')), 'B') || setweight(to_tsvector('french', COALESCE(overview,'')), 'C')`: it reads only columns of the same `media` row (not `media_metadata`), so §6.3's condition holds. Today a raw `UPDATE` after save is called from 6 sites: `media-import.service.ts:452,509,598,679`, `media-mutation.service.ts:76`, `media-metadata.service.ts:275` (method `:1239-1249`); every other path that changes `title`/`originalTitle`/`overview` leaves the vector stale and a never-refreshed row has NULL. `[ts:src/modules/media/media-service/media-metadata.service.ts:1239-1249]`
63. **Decision: DB trigger, written by nobody.** S3 adds migration `server/migrations/<ts>_media_search_vector.sql`: function `media_search_vector_update()` computing the expression of rule 62 into `NEW."searchVector"`, `CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", overview ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update()`, then a one-time backfill `UPDATE media SET "searchVector" = <expr>` run with the `set_updated_at` trigger disabled (`ALTER TABLE media DISABLE TRIGGER set_updated_at` … `ENABLE`, so C8 does not bump every `updatedAt`). `BEFORE` triggers fire alphabetically (`media_search_vector` before `set_updated_at`), no interaction. After S5 no Rust persist path writes the vector (no function to call, nothing to list); `to_tsvector('french', …)` with a literal regconfig is immutable so the expression is legal in the function. Rows saved through paths that never refreshed the vector now carry one, so FTS may match titles it missed. The migration also creates the GIN index (rule 65). `[new]` (plan §15.3 "Search vector": an internal mechanism change with no F/C id; no client-visible contract change beyond the extra matches)
64. Nest during S3-S5: the 6 call sites and `updateSearchVector` are **deleted in the S3 PR** (redundant with the trigger, plan §0 rule 4); their spec mocks (`updateSearchVector: jest.fn()` in `media-mutation.service.spec.ts:52,70`, `media-import.*.spec.ts`) go with them. No bridge is needed: Nest writes `title`/`overview`, the trigger runs in the database. `[ts:src/modules/media/media-service/media-import.service.ts:452]`, `[ts:src/modules/media/media-service/media-import.service.ts:509]`, `[ts:src/modules/media/media-service/media-import.service.ts:598]`, `[ts:src/modules/media/media-service/media-import.service.ts:679]`, `[ts:src/modules/media/media-service/media-mutation.service.ts:76]`, `[ts:src/modules/media/media-service/media-metadata.service.ts:275]`
65. The entity declares `@Index('idx_media_search_vector', { synchronize: false })` but no migration creates it (`grep idx_media_search_vector server/migrations backend/src/migrations` finds nothing): FTS is a sequential scan today. `[new]` The S3 migration adds `CREATE INDEX idx_media_search_vector ON media USING gin ("searchVector")` (plan §15.3); no trigram index. `persons."searchVector"` (`to_tsvector('simple', name)`, `media-metadata.service.ts:1183`, `persons.service.ts:59`) is S5 (persons) and is the same trigger candidate there; not decided here. `[ts:src/modules/media/entities/media.entity.ts:30]`
66. Parity seed: `server/parity/seed/build.sh` inserts media without a vector (all NULL). Both targets load the same dump, so the seed delta must populate `searchVector` with the rule 62 expression for every media row (otherwise the S3 backfill gives Rust vectors Nest does not have and FTS-only matches diverge). `[new]` (plan §15.3 Parity: the seed gains a computed `searchVector`; seed read `server/parity/seed/build.sh:62-82`).

## SQL

Notation: `$ids` = accessible library ids (`int4[]`), `$user` = caller id. Equivalent SQL for TypeORM builders is tagged with the Nest call site; raw SQL is verbatim.

**Q-A (ACL, libraries rules 30, 32)** `SELECT id FROM libraries` (admin) / `SELECT "libraryId" FROM library_user_access WHERE "userId" = $1`; `SELECT m."libraryId" AS "libraryId" FROM media m WHERE m.id = $1`. `[ts:src/modules/libraries/libraries.service.ts:63-74]`, `[ts:src/modules/media/media-service/media-query.service.ts:585-603]`

**Q-L1 (list: page ids)** equivalent of TypeORM phase (a), rules 15-24 (`<where>` = ACL + filters + user clauses + FTS, all ANDed):

```sql
SELECT media.id
FROM media
WHERE media."libraryId" = ANY($ids) AND <filters> AND <user clauses> AND <fts>
ORDER BY <sort col> <ASC|DESC>, media.id ASC
LIMIT $limit OFFSET $offset          -- only when limit > 0
```

**Q-L2 (list: total)** `SELECT COUNT(*) FROM media WHERE <same where>` (Nest: `COUNT(DISTINCT(media.id))` over the joined query). `[ts:src/modules/media/media-service/media-query.service.ts:259]`

**Q-L3 (list: hydrate)** (`.*` below stands for the entity columns of rule 30, never `searchVector`; a null FK column means the relation-id key is omitted) `SELECT media.*, library.*, "qualityProfile".*, "languageProfile".* FROM media LEFT JOIN libraries library ON library.id = media."libraryId" LEFT JOIN quality_profiles ... LEFT JOIN language_profiles ... WHERE media.id = ANY($page_ids)`; `SELECT * FROM media_files WHERE "mediaId" = ANY($page_ids) ORDER BY id`; reassemble in `$page_ids` order. `[ts:src/modules/media/media-service/media-query.service.ts:212-218]`

**Q-W (watched subquery, verbatim)** `[ts:src/modules/media/media-service/media-query.service.ts:65-86]`:

```sql
  SELECT DISTINCT ps."mediaId" AS id FROM playback_states ps
  INNER JOIN media m ON m.id = ps."mediaId"
  WHERE ps."userId" = :userId AND ps.completed = true AND m.type = 'movie'
  UNION
  SELECT m2.id FROM media m2
  WHERE m2.type = 'series'
  AND EXISTS (
    SELECT 1 FROM seasons s
    JOIN episodes e ON e."seasonId" = s.id
    WHERE s."mediaId" = m2.id AND s."seasonNumber" > 0 AND e."hasFile" = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM seasons s
    JOIN episodes e ON e."seasonId" = s.id
    WHERE s."mediaId" = m2.id AND s."seasonNumber" > 0 AND e."hasFile" = true
    AND NOT EXISTS (
      SELECT 1 FROM playback_states ps2
      WHERE ps2."userId" = :userId AND ps2."episodeId" = e.id AND ps2.completed = true
    )
  )
```

**Q-M (missing-episode predicate, `onDiskSql('me')` expanded)** `[ts:src/modules/media/media-service/media-query.service.ts:1064-1071]`, `[ts:src/modules/media/episode-coverage.util.ts:73-83]`:

```sql
EXISTS (
  SELECT 1 FROM seasons ms JOIN episodes me ON me."seasonId" = ms.id
  WHERE ms."mediaId" = media.id AND ms."seasonNumber" > 0
    AND ms.monitored = true AND me.monitored = true
    AND me."airDate" <= $today AND NOT ("me"."hasFile" = true OR EXISTS (
      SELECT 1 FROM "episodes" cov
      WHERE cov."seasonId" = "me"."seasonId"
        AND cov."hasFile" = true
        AND cov."endEpisodeNumber" IS NOT NULL
        AND "me"."episodeNumber" > cov."episodeNumber"
        AND "me"."episodeNumber" <= cov."endEpisodeNumber"
    ))
)
```

**Q-S (episode stats, page series ids)** `[ts:src/modules/media/media-service/media-query.service.ts:427-468]`:

```sql
SELECT s."mediaId",
       COUNT(e.id) AS total,
       COUNT(e.id) FILTER (WHERE <onDiskSql('e')>) AS downloaded
FROM seasons s
JOIN episodes e ON e."seasonId" = s.id
WHERE s."mediaId" = ANY($1) AND s."seasonNumber" > 0
GROUP BY s."mediaId"
```

**Q-C (cutoff episodes)** verbatim `[ts:src/modules/media/media-service/media-query.service.ts:304-318]`:

```sql
SELECT s."mediaId" AS "mediaId",
       e.id      AS "epId",
       e."episodeNumber" AS "episodeNumber",
       e."endEpisodeNumber" AS "endEpisodeNumber",
       f."quality" AS "quality"
  FROM seasons s
  JOIN episodes e ON e."seasonId" = s.id
  LEFT JOIN media_files f ON f."episodeId" = e.id
 WHERE s."mediaId" = ANY($1)
   AND s."seasonNumber" > 0
   AND e.monitored = true
```

**Q-P (watched/progress, verbatim)** `[ts:src/modules/media/media-service/media-query.service.ts:378-407]`; `$1` = user, `$2` = page ids:

```sql
SELECT m.id::int AS id,
  (
    (m.type = 'movie' AND EXISTS (
      SELECT 1 FROM playback_states ps
      WHERE ps."userId" = $1 AND ps."mediaId" = m.id AND ps.completed = true
    ))
    OR
    (m.type = 'series'
      AND EXISTS (
        SELECT 1 FROM seasons s JOIN episodes e ON e."seasonId" = s.id
        WHERE s."mediaId" = m.id AND s."seasonNumber" > 0 AND e."hasFile" = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM seasons s JOIN episodes e ON e."seasonId" = s.id
        WHERE s."mediaId" = m.id AND s."seasonNumber" > 0 AND e."hasFile" = true
          AND NOT EXISTS (
            SELECT 1 FROM playback_states ps2
            WHERE ps2."userId" = $1 AND ps2."episodeId" = e.id AND ps2.completed = true
          )
      )
    )
  ) AS watched,
  CASE WHEN m.type = 'movie' THEN COALESCE((
    SELECT ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)::int
    FROM playback_states ps
    WHERE ps."userId" = $1 AND ps."mediaId" = m.id AND ps."episodeId" IS NULL
      AND ps.completed = false AND ps."durationSeconds" > 0
    ORDER BY ps."lastPlayedAt" DESC LIMIT 1
  ), 0) ELSE 0 END AS progress
FROM media m
WHERE m.id = ANY($2::int[])
```

**Q-R (recently-added ids)** equivalent of the TypeORM raw query, rule 33 (`<user>` = optional `AND media.id NOT IN (<Q-W with $user>)` / `AND media."addedById" = $user`; `<lib>` = optional `AND media."libraryId" = $n`) `[ts:src/modules/media/media-service/media-query.service.ts:498-542]`:

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

**Q-G (genres, verbatim)** `[ts:src/modules/media/media-service/media-query.service.ts:151-164]`:

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

**Q-K (collections, verbatim)** `[ts:src/modules/media/media-service/media-query.service.ts:182-196]`:

```sql
SELECT m."tmdbCollectionId"   AS id,
       m."tmdbCollectionName" AS name,
       COUNT(*)::int          AS count,
       COALESCE(
         (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
          FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
         ARRAY[]::text[]
       ) AS posters
FROM media m
WHERE m."libraryId" = ANY($1)
  AND m."tmdbCollectionId" IS NOT NULL
  AND m."tmdbCollectionName" IS NOT NULL
GROUP BY m."tmdbCollectionId", m."tmdbCollectionName"
HAVING COUNT(*) >= 2
ORDER BY m."tmdbCollectionName" ASC
```

**Q-N (counts)** `SELECT COUNT(*) FROM media WHERE type = $1 AND "libraryId" = ANY($ids)` for `movie` and `series` (`1 = 0` when `$ids` empty). `[ts:src/modules/media/media-service/media-query.service.ts:106-121]`

**Q-D (calendar)** equivalent, rules 47-51 `[ts:src/modules/media/media-service/media-query.service.ts:848-977]`:

```sql
-- movies
SELECT m.*, f.id AS file_id FROM media m LEFT JOIN media_files f ON f."mediaId" = m.id
WHERE m.type = 'movie'
  AND (m."inCinemas" BETWEEN $s AND $e OR m."digitalRelease" BETWEEN $s AND $e
       OR m."physicalRelease" BETWEEN $s AND $e OR m."releaseDate" BETWEEN $s AND $e)
  [AND m.monitored = true] [AND m."addedById" = $user] AND m."libraryId" = ANY($ids)
-- episodes
SELECT ep.id, ep."episodeNumber", ep.title, ep."airDate", ep."hasFile",
       season."seasonNumber", media.id AS "mediaId", media.title AS "mediaTitle",
       media."posterUrl", media."fanartUrl", media.status, media.year,
       <onDiskSql('ep')> AS "onDisk"
FROM episodes ep
INNER JOIN seasons season ON season.id = ep."seasonId"
INNER JOIN media media ON media.id = season."mediaId"
WHERE ep."airDate" BETWEEN $s AND $e
  [AND media.monitored = true AND ep.monitored = true] [AND media."addedById" = $user]
  AND media."libraryId" = ANY($ids)
ORDER BY ep."airDate" ASC
```

**Q-X (similar candidates)** equivalent, rules 52-54 `[ts:src/modules/media/media-service/media-related.service.ts:135-168]`:

```sql
SELECT m.*, meta.id, meta.keywords, (SELECT COUNT(*) FROM media_files f WHERE f."mediaId" = m.id) AS "fileCount"
FROM media m LEFT JOIN media_metadata meta ON meta."mediaId" = m.id
WHERE m."libraryId" = $source_library AND m.type = 'movie' AND m.id != $source
  AND ( 1 = 0
        OR jsonb_exists_any(m.genres, ARRAY[$genres...])          -- if source genres
        OR jsonb_exists_any(meta.keywords, ARRAY[$keywords...])   -- if source keywords
        OR m.id IN ($sameDirectorIds...) )                        -- if any
  AND (m."tmdbCollectionId" IS NULL OR m."tmdbCollectionId" != $source_collection)   -- if source has one
```

Director lookups: `SELECT crew.*, person.* FROM media_crew crew JOIN persons person ON person.id = crew."personId" WHERE crew."mediaId" = $1 AND crew.job = 'Director'`; `SELECT crew."mediaId" FROM media_crew crew WHERE crew."personId" IN (...) AND crew.job = 'Director' AND crew."mediaId" != $1`. `[ts:src/modules/media/media-service/media-related.service.ts:217-238]`

**Q-F (collection)** `SELECT m.*, (SELECT COUNT(*) FROM media_files f WHERE f."mediaId" = m.id) AS "fileCount" FROM media m WHERE m."libraryId" = $lib AND m."tmdbCollectionId" = $c ORDER BY m."releaseDate" ASC NULLS LAST, m.year ASC NULLS LAST`. `[ts:src/modules/media/media-service/media-related.service.ts:191-215]`

**Q-O (detail)** `SELECT * FROM media WHERE id = $1` then one query per relation (strategy `query`): `seasons WHERE "mediaId"`, `episodes WHERE "seasonId" = ANY`, `media_files WHERE "mediaId"`, `quality_profiles`, `language_profiles`, `libraries`, `media_metadata WHERE "mediaId"`. `[ts:src/modules/media/media-service/media-query.service.ts:643-662]`

**Q-CC (cast / crew)** `SELECT mc.*, p.* FROM media_cast mc JOIN persons p ON p.id = mc."personId" WHERE mc."mediaId" = $1 ORDER BY mc."order" ASC` (`, mc.id ASC`); crew same on `media_crew` with `ORDER BY mc.id ASC`. `[ts:src/modules/media/media-service/media-query.service.ts:622-635]`

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

### K. Deviations decided for the port (plan §15.3)

67. [new] C10: `q` present and `sortBy` absent: order by `ts_rank(media."searchVector", <TSQ>) DESC NULLS LAST, media.title ASC, media.id ASC` (a NULL rank, i.e. a row without vector matched by ILIKE/similarity, sorts last; `sortOrder` is ignored). "Absent" means the key is missing: an empty or unknown `sortBy` is present and falls back to `title` (rule 17). With `sortBy` present the requested sort applies. Note: the client search page always sends `sortBy=title` when no panel sort is chosen (`client/src/app/features/search/search.ts:671`), so C10 changes nothing there until the client omits it (Q3).
68. [new] C11: `cutoffUnmet=true` is applied in SQL before pagination: `page`, `limit` and `total` count only the media that pass (rule 26 predicates). Ranks come from `parseReleaseQuality` (rule 69, Rust), not from an exact name match, so SQL cannot rank by itself: either pass a `(quality text, rank int)` mapping (two arrays + `unnest`) built from the distinct `media_files.quality` strings of the filtered media, or pre-filter the filtered ids in Rust before paging; the porter chooses. Keep rule 26's quirks: no profile or unknown cutoff id = dropped, a movie without files has rank 0, series shadowing pooled across seasons, series with no monitored episode in seasons `> 0` dropped. A page is full unless it is the last.
69. [new] Release-quality subset in S3: `parseReleaseQuality`, `rankFromQualityString`, `getAppQualityById` and `APP_QUALITIES` (rule 44, rule 37) are ported to `fliks_domain` in S3 with their vectors (`release-quality`, `app-qualities`; plan §5.2 `release-parsing`, built in S3). S5 extends the module.
70. [new] Allowed duplication, listed in `bridge.md`: "release quality parsing in Nest until S5" (Nest keeps `quality.parser.ts` and `app-qualities.ts` for imports; the same vectors guarantee equality). No endpoint.
71. [new] C1 extended to the catalog routes: non-integer or out-of-range integer filters, `page < 1` with `limit > 0`, `limit < 0` on `recently-added`, `page`/`limit` beyond int8, calendar dates Postgres cannot parse (rule 47), a null on a non-nullable field: 400 with the standard validation body; a `sortBy` naming an `Object.prototype` member: `title` (rule 17); path ids that are not plain decimals or exceed int4: 400 (`PathParams`, rule 3); unknown ids: 404; `streams` on a library without `path`: 400 or 404 (Q1). Never 500.
72. [new] C12: every list has a final tie-break `id ASC`: `GET /api/media` (after the sort, rule 16), `recently-added` (rule 33), `collections`, `similar`, `collection`, `cast`, `crew`, `calendar`, `files` of a media, and the `seasons`/`episodes` of `MD` and `tracking` among equal `seasonNumber`/`episodeNumber`. Parity still compares equal-key arrays order-insensitively.
73. [new] F22: `path` (the `Media.path` getter of rule 30) and `library.path` are serialised only for callers who can manage libraries (`settings.access` or `manage:all`, the `Manage Library` ability, `[ts:src/modules/auth/casl/casl-ability.factory.ts:131-139]`); for every other `media.read` caller both keys are absent from `MLI` (list, `recently-added`) and `MD`. `tracking`, `streams`, `RI`, calendar and cast/crew carry no absolute path. In the seed only `admin` keeps them. `files[].relativePath` and `streamInfo` are not absolute paths and stay. Client audit of `Media.path` / `library.path` readers is an S3 task (`client-audit.md`).
74. [ts:src/modules/media/media.controller.ts:914-922] Kept as is (plan §15.3): `GET :id/collection` with no collection answers 200 with an empty body (rule 10, 57); `media_metadata` bigints (`budget`, `revenue`) stay strings; only the exact string `true` is a true boolean query parameter (rule 5); `streams` answers `[]` when the engine is down (rule 61).

## Events

none (read-only routes).

## Settings keys

none (no `app_settings` key is read by these routes).

## Jobs/timers

none.

## Bridges

none. Reads share the database with Nest (no cache on either side); the ACL duplication is the listed `bridge.md` duplication of libraries rule 36 (not an endpoint). `streams` calls the engine directly through the Rust engine client (S2), never through Nest. The search vector needs no bridge (rule 64). Listed duplication in `bridge.md` (not an endpoint): "release quality parsing in Nest until S5" (rule 70). The kept Nest methods (Deletes) are also live second copies of rules ported here and go to `bridge.md` "Allowed duplication" in the S3 PR: "media detail hydration in Nest until S5" (`findOne`: the write routes return `MD`, rules 31-32, and `Media.path`, rule 30), "counts by library in Nest" (`getCountsByLibrary` for `/api/counts`, rule 36), "episode coverage SQL in Nest until S5" (`onDiskSql`, used by acquisition; Q-M, Q-S, calendar). Routing: `GET /api/media/sync-queue` explicit forward to Nest until S6 (Routes, class-level note).

## Deletes in Nest

Milestone S3 (plan §10 S3 lists `media-query.service.ts`, `media-related.service.ts`, the read handlers of `media.controller.ts`). The importer rule (plan §15.1) keeps parts of `media-query.service.ts` alive: the partial delete is confirmed in plan §15.3.

- `backend/src/modules/media/media.controller.ts`, partial (file stays for the write routes): delete the read handlers at `:119-125` (`findAll`), `:127-145` (`recentlyAdded`), `:147-153` (`counts`), `:155-161` (`countsByLibrary`), `:163-167` (`qualityDefinitions`), `:168-186` (`genres` with its doc block), `:188-201` (`collections`), `:203-209` (`calendar`), `:217-225` (`tracking`), `:836-851` (`getStreams`), `:887-897` (`findOne`), `:899-912` (`getSimilar`), `:914-922` (`getCollection`), `:924-932` (`getCast`), `:934-942` (`getCrew`) (decorators included; confirm ranges with `tools/sym`); then drop imports that became unused (`SearchMediaDto`, `CalendarQueryDto`, `RecentlyAddedDto`, `APP_QUALITIES`, `FfprobeService`/`this.ffprobe` and `Query` if no other handler uses them). `assertMediaAccessible` (`:81-88`) stays (write routes). The declaration-order constraint disappears with the literal routes.
- `backend/src/modules/media/media-service/media-related.service.ts`: whole file; `media-related.scoring.spec.ts`: whole file (cases move to the `media-similarity` vectors); `MediaRelatedService` provider in `media.module.ts:25,73` and constructor/field `related` + `findSimilar`/`findCollection` in `media.service.ts:43,127-132`.
- `backend/src/modules/media/media-service/media-query.service.ts`, partial. DELETE: types `CutoffState`..`TrackingStatus` (`:21-53`), `WATCHED_MEDIA_IDS_SUBQUERY` (`:55-86`), `getCounts` (`:106-121`), `getGenres` (`:137-169`), `getCollections` (`:171-201`), `findAll` (`:203-362`), `attachWatchedProgress` (`:364-420`), `attachEpisodeStats` (`:422-468`), `findRecentlyAdded` (`:470-560`), `getCast` (`:622-628`), `getCrew` (`:630-635`), `getTrackingStatus` + `qualityLabel` (`:688-791`), `getCalendar` (`:793-982`), `applyFilters` (`:1004-1091`), `applyFullTextSearch` (`:1093-1124`), plus the now-unused imports (`Brackets`, `RecentlyAddedMode`, `SearchMediaDto`, `CalendarQueryDto`, `MediaType` only if unused, `rankFromQualityString`, `parseReleaseQuality`, `getAppQualityById`, `AppQualityDefinition`, `shadowedEpisodeNumbers`, `onDiskSql`, `Episode` repo only if unused, `castRepo`/`crewRepo`/`MediaCast`/`MediaCrew`, `dataSource`/`DataSource` (only `findAll`/`attachEpisodeStats` use it)). KEEP (still imported): `getCountsByLibrary` (`:123-135`, `counts.service.ts:92`, S8) with `applyLibraryAcl` (`:984-1002`); `findByTmdbId` (`:562-579`, `requests.service.ts:390,576,807,895,1001`, requests move in S5, plan §15.3); `assertAccessible` (`:581-603`, `media.controller.ts:87,895`, `plugin-object-guards.service.ts:57`, write routes S5, plugins S8); `getMediaIdForSeason`/`getMediaIdForEpisode` (`:605-620`, write routes S5); `findOne` (`:637-686`, `media-mutation.service.ts:61,78,116,129,136,168,218`, `media.service.ts:253`, S5).
- `backend/src/modules/media/media-service/media-query.applyfilters.spec.ts`: whole file (cases become parity scenarios).
- `backend/src/modules/media/media.service.ts`, partial: delete `getCounts`, `getGenres`, `getCollections`, `findAll`, `findRecentlyAdded`, `findSimilar`, `findCollection`, `getTrackingStatus`, `getCast`, `getCrew`, `getCalendar` and their imports (`SearchMediaDto`, `CalendarQueryDto`, `MediaCast`, `MediaCrew`, `MediaRelatedService` with the `related` field); keep `getCountsByLibrary`, `findByTmdbId`, `findOne`, `assertAccessible`, `getMediaIdForSeason`, `getMediaIdForEpisode`.
- DTOs: `dto/search-media.dto.ts`, `dto/recently-added.dto.ts`, `dto/calendar-query.dto.ts`: whole files (only importers are the deleted handlers/methods; re-grep before deleting).
- Search vector (rule 64): remove `updateSearchVector` (`media-metadata.service.ts:1239-1249`) and its 6 call sites; update the specs that mock it.
- `backend/src/modules/media/episode-coverage.util.ts`: stays (importers `acquisition-candidates.service.ts:9`, `request-lifecycle.service.ts:16`, `fliks-host.service.ts:21`); `shadowedEpisodeNumbers` loses its only caller (`media-query.service.ts:19`): delete it if the grep confirms.
- Remaining Nest importers after S3: `media-mutation.service.ts` and `media.service.ts` (`findOne`), `requests` (`findByTmdbId`, until S5), `counts.service.ts` (`getCountsByLibrary`, S8), `plugin-object-guards.service.ts` (`assertAccessible`, S8), the write handlers of `media.controller.ts` (S5). `MediaQueryService` is deleted at S5 (`M/media/**`), but `counts.service.ts` and `plugin-object-guards.service.ts` still call it until S8 (Q4); `quality.parser.ts` and `app-qualities.ts` stay until S5 (importers in imports, profiles, plugin host).

## Vectors/parity

**Vector set `media-filters` (plan §5.2)**: no TS fixtures: `media-query.applyfilters.spec.ts` asserts SQL strings (it only checks `andWhere` text), which say nothing about behaviour; behaviour is asserted through the parity scenarios below. Additional sets added with the S3 port (plan §15.3; generated by `backend/test/server-vectors/media-query.ts` from the real TS functions): `media-search-query` (rule 24 prefix tsquery builder: ~40 inputs incl. accents, apostrophes `l'impossible`, digits, `U+0085`/`U+FEFF`/`U+00A0` separators, symbol-only, empty after trim), `media-similarity` (`scoreSimilarity` + `sharedCount`/`cosineOverlap`, fixed-seed combinations incl. duplicates, case differences, null years), `app-qualities` (the 24-row array), `release-quality` (`parseReleaseQuality` + `rankFromQualityString` on `quality.parser.spec.ts` plus a corpus of stored `media_files.quality` strings and release names, needed by `tracking`/`cutoffUnmet`, rule 69), `media-path` (rule 30 `path` getter: normalisation, empty `folderName`, null library path). Rust tests replay them (`BLESS=1` convention).

**Seed delta required** (parity seed has 17 movies + 3 series, identical `createdAt`/`rating`/`year`/genres, NULL `searchVector`, no metadata/cast/profiles/collections; see `server/parity/seed/build.sh`): a `media-query` seed extension (deterministic SQL, no external calls): distinct `createdAt` per media and per `media_files` (days apart) so `added` and recently-added are deterministic; ≥ 30 media in total (default page 25 has a second page); varied `year` (incl. NULL, 0-free), `rating` (incl. NULL, ties), `genres` (`["Drama"]`, `["Action","Drama"]`, `["Comedy"]`, NULL, `[]`, one lower-case `drama`); titles with a lowercase first letter, a digit first (`12 Angry Men`), an accented first letter (`Éclair`), an apostrophe (`L'Impossible`), a French stem pair (`Les Évadés`) and `originalTitle`/`overview` text; `searchVector` populated with the rule 62 expression; one media with `"libraryId" IS NULL`; media with a quality profile (`cutoff` = 18) and files of mixed quality (`WEBDL-720p`, `Bluray-1080p`, `''`, an 8K name); a series with a multi-episode file (`endEpisodeNumber`), an unmonitored episode, a specials season 0, episodes with far-past (`2000-01-01`) and far-future (`2099-01-01`) `airDate` and no file (never relative to "today"); a fully watched series and a half-watched one for `onlyWatched`; `addedById` set on some media; two media sharing `tmdbCollectionId` in library 1, one alone, one in library 2; `media_metadata` rows with `keywords`, `budget`/`revenue`; `persons` + `media_cast` (with equal `order`) + `media_crew` (`Director`); calendar dates inside a fixed month (`2026-03`); media files under `/tmp/fliks-parity/media` for `streams` (engine up). Also needed to pin rules 19-27, 40 and 48: a media with `tmdbId`/`tvdbId`/`imdbId` all NULL and one with only `imdbId = ''` (`unidentified`); an unmonitored movie and `status` values beyond `released`/`continuing`; a movie with **no** `media_files` row (`missing`, `cutoffUnmet` rank 0, recently-added `file` mode, `similar` `hasFile: false`); a language profile on one media; a quality profile whose `cutoff` is not a table id (`99`); a monitored, aired, file-less episode inside an **unmonitored** season (not missing) and a shadowed episode with a past `airDate` covered by its owner's file (not missing); a series with no file-backed episode (never watched); an incomplete movie playback of `450/3600` for `user` (progress 12, half-even); movies in `2026-03` with `inCinemas`+`digitalRelease` inside, with only `releaseDate` inside, and with `releaseDate` inside but `inCinemas` outside. The delta's `createdAt` values must be written **after** `build.sh`'s normalising block (it sets every `createdAt`/`updatedAt` to `2026-01-01`). Seeded users: `admin` (all libraries), `user`/`other`/`manager` (libraries 1-2), `readonly` (library 1 only).

**Parity scenarios** (`server/parity/scenarios/media-query/`, recorded against Nest before the port, plan §5.3; pagination/sort scenarios with equal keys use the runner's `unordered` for `$.data`). Missing actor: no seeded user lacks `media.read`, so the seed gains a `noread` actor (role with no permissions + user, plan §15.3) for the 403 cases.

| Scenario | Covers |
|---|---|
| `list-default-admin`, `list-default-user`, `list-default-readonly` | defaults (`page 1`, `limit 25`, `title ASC`), ACL scoping (readonly sees library 1 only), shape of `MLI` (rule 30 key presence: `libraryId`, `files[].episodeId` absent for movies, `episodeStats` absent for movies), `watched`/`progressPercent` per actor |
| `list-unauthenticated`, `list-stream-token` (F8 deviation), `list-forbidden-noread` | 401, F8 401, 403 |
| `list-page-2`, `list-page-beyond-end` (`data: []`, `total` kept), `list-limit-small`, `list-limit-zero` (all rows), `list-limit-negative` (all rows), `list-limit-fraction` (`limit=2.5`: 3 rows), `list-page-zero` (Nest 500, Rust 400: `deviation: "C1"`), `list-page-zero-limit-zero` (200, all rows) | rules 9, 14, parent-id pagination, count |
| `list-sort-title-desc`, `list-sort-year-asc/desc` (NULL placement), `list-sort-rating` (ties, `unordered`), `list-sort-added`, `list-sort-createdAt`, `list-sort-unknown-key` (falls back to title), `list-sort-lowercase-desc` (`desc` is ASC), `list-sort-ties-pages` (page membership with equal keys, DESC id tie-break ASC), `list-sort-proto-key` (`constructor`: Nest 500, Rust title: `deviation: "C1"`) | rules 16-17 |
| `list-filter-type`, `-status`, `-monitored-true`, `-monitored-false`, `-monitored-garbage` (`yes` = false), `-year`, `-year-zero` (ignored), `-yearmin-zero`, `-yearmin-yearmax`, `-votemin`, `-libraryid`, `-libraryid-outside-acl` (empty), `-collectionid`, `-qualityprofileid`, `-languageprofileid`, `-year-fraction` (Nest 500, Rust 400: `deviation: "C1"`), `-votemin-empty` (`''` = 0 excludes NULL ratings) | rule 19 guards and null handling |
| `list-filter-genre`, `-genre-case` (`drama` vs `Drama`), `-genres-comma`, `-genres-repeated`, `-genres-empty`, `-genre-and-genres` | jsonb containment, AND semantics, case sensitivity |
| `list-filter-missing-true`, `-missing-false`, `-unidentified`, `-letter-a`, `-letter-lower`, `-letter-hash`, `-letter-accent` (`É` no filter), `-letter-two-chars` (no filter) | rules 22-23 |
| `list-filter-excludewatched`, `-onlywatched`, `-both-watched-flags`, `-requestedbyme`, `-cutoffunmet-movies`, `-cutoffunmet-series-shadowed`, `-cutoffunmet-unknown-cutoff` (dropped), `list-progress-half-even`, `-cutoffunmet-page-total` (Nest: page shorter than `limit`, `total` unchanged; Rust: full pages, correct `total`: `deviation: "C11"`) | rules 20, 26 |
| `list-search-prefix` (`impos`), `-search-two-words`, `-search-accent`, `-search-stopword`, `-search-symbols-only`, `-search-ilike-wildcard` (`%`, `_`), `-search-similarity` (typo > 0.8), `-search-original-title`, `-search-whitespace-only`, `-search-with-sort` (requested sort applied), `-search-rank-order` (no `sortBy`: Nest title order, Rust rank order: `deviation: "C10"`), `-search-null-vector` (row without vector found only through ILIKE), `-search-long-word` (3000-character word ignored, 200) | rule 24, 18 |
| `list-validation-unknown-key`, `-bad-type`, `-bad-status`, `-nan-year` , `-array-q`, `-bad-boolean-array` | 400 bodies (messages compared by `statusCode` + `error`) |
| `recently-added-file`, `-media`, `-both`, `-limit`, `-limit-zero`, `-library`, `-excludewatched`, `-requestedbyme`, `-bad-mode`, `-unauthenticated`, `-shape-no-watched`, `-limit-negative` (Nest 500, Rust 400: `deviation: "C1"`), `-limit-fraction` | rules 33-34 |
| `counts-admin`, `-user`, `-readonly`, `-unauthenticated`; `counts-by-library-admin`, `-readonly`, `-unauthenticated` | rules 35-36, key type |
| `qualities-ok`, `qualities-unauthenticated`, `qualities-stream-token` | rule 37, F8 |
| `genres-all`, `genres-library`, `genres-library-outside-acl`, `genres-library-garbage` (`abc`, `0`, `12abc`), `genres-readonly`, `genres-empty-scope`; `collections-all`, `-library`, `-outside-acl`, `-single-member-hidden` | rule 38, posters ordering |
| `calendar-month`, `-explicit-range`, `-only-start` (current month: fixed via an explicit range in the other scenarios; this one asserts only shape), `-type-movie`, `-type-series`, `-monitoredonly`, `-requestedbyme`, `-readonly-scope`, `-shadowed-episode-hasfile`, `-release-fallback`, `-season0-included`, `-compact-dates` (`20260301`..`20260331`: episodes only), `-bad-date` (`2026-02-30`, `2026-03`: Nest 500, Rust 400: `deviation: "C1"`), `-bad-type` | rules 47-51 |
| `tracking-movie-met`, `-movie-below`, `-movie-no-profile`, `-movie-missing`, `-movie-unmonitored`, `-movie-below-same-resolution` (names, not labels), `-unknown-cutoff` (`hasProfile: true`, `no-profile`), `-8k-file` (`WORKPRINT`), `-empty-quality` (`Bluray-480p`), `-series-multi-episode`, `-series-specials-last`, `-notfound`, `-outside-acl`, `-badid`, `-unauthenticated` | rules 39-46 |
| `detail-movie`, `detail-series` (season order, specials last, episode order, hasFile heal), `detail-no-metadata` (`metadata: null`), `detail-with-metadata` (bigint strings), `detail-notfound`, `detail-null-library` (404 even for admin), `detail-outside-acl`, `detail-badid`, `detail-id-out-of-range` (Nest 500, Rust 400: `deviation: "C1"`), `detail-id-noncanonical` (`%207%20`, `1e1`: Nest 200, Rust 400, Q2), `detail-unauthenticated`, `detail-movie-user` (`path`, `library.path` absent: `deviation: "F22"`; every non-admin `MLI`/`MD` scenario carries it) | rules 3, 31-32, 73 |
| `similar-default`, `-limit`, `-limit-garbage`, `-limit-cap`, `-limit-fraction` (`0.5`: `[]`), `-series-empty`, `-no-signal-empty`, `-excludes-collection`, `-director-only`, `-notfound`, `-outside-acl`; `collection-ok`, `-none-empty-body`, `-alone-empty-body`, `-notfound`, `-outside-acl` | rules 52-57 (200 empty body recorded as `body: null` with empty-body flag) |
| `cast-ok`, `crew-ok`, `cast-empty`, `cast-notfound`, `cast-outside-acl` | rule 58 |
| `streams-ok` (engine up), `streams-engine-down` (`[]`), `streams-file-of-other-media` (404), `streams-notfound-media`, `streams-badid`, `streams-library-no-path` (Nest 500, Rust 400/404: `deviation: "C1"`) | rules 59-61 |
| `sync-queue-forwarded` (after the port `GET /api/media/sync-queue` is still Nest's answer, not a Rust 400) | class-level routing note |
| `search-vector-trigger` (Rust-side test, not parity): insert/update `title`/`overview` through SQL and assert `searchVector` equals the rule 62 expression; the backfill migration leaves `updatedAt` unchanged | rule 63 |

## Open questions (left open by plan §15.3)

- Q1. Status for `GET :id/streams/:mediaFileId` on a media whose library has no `path` (rule 60): C1 only requires 400 or 404, never 500. S3.
- Q2. Path ids Nest accepts through the global pipe's `+value` (`%207%20`, `1e1`, `0x10`, `0b11`, `%20` = 0; rule 3): the shared Rust `PathParams<i32>` answers 400 where Nest serves media 7/10/16/3 or 404s. Accept the deviation (record it, like C9 for images), or make `PathParams` mimic `+value`. Applies to every `ParseIntPipe` route already ported (`users.md` rule 6, `auth.md` rule 18 describe only the regex). S3.
- Q3. C10 only acts when `sortBy` is absent, but the client search page always sends `sortBy=title` (rule 67): does S3 change the client to omit it for the default sort, or is C10 left without effect? S3.
- Q4. `MediaQueryService` (`M/media/**`) is deleted at S5, yet `counts.service.ts` (`getCountsByLibrary`, `/api/counts`) and `plugin-object-guards.service.ts` (`assertAccessible`) keep calling it until S8: which milestone moves or re-homes those two callers? S5 planning.
