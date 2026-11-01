# Spec: media-servers (Emby: connections, library refresh dispatch, watch-history import)

Only Emby is implemented; `jellyfin`, `plex` and `local` are accepted values of the `type` enum with no provider behind them.

## Routes

8 routes, all in the media-servers controller. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard`; the extractor rejects a `scope:'stream'` token with 401. `Read Settings` and `Manage Settings` are satisfied by `settings.access` or `manage:all` (auth rules 20, 25). Validation body = auth rule 16 (unknown keys 400); path ids are canonical integers only (auth rule 18).

`MediaServerRow`: `{id: number, createdAt: ISO string, updatedAt: ISO string, name: string, type: 'local'|'jellyfin'|'emby'|'plex', url: string, apiKey: string, events: string[], enabled: boolean, apiKeySet: boolean}`. `apiKey` is answered as `""` on every route (4.x edit forms call `.trim()` on it, so the key stays a string); `apiKeySet` says whether a non-empty key is stored. `TypeInfo` = `{type: string, label: string, supportedEvents: string[]}`.

| Method path | Auth (extractor + policy) | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/media-servers/types` | `Read Settings`| none | 200 `TypeInfo[]`: `[{type:'emby', label:'Emby', supportedEvents:[7 events, rule 9]}]` | 401, 403 | none |
| `POST /api/media-servers` | `Manage Settings`| `CreateMediaServerDto` (rule 1) | 201 `MediaServerRow` | 400 validation | INSERT `media_servers` |
| `GET /api/media-servers` | `Read Settings`| none | 200 `MediaServerRow[]` ordered `name ASC` then `id ASC` | 401, 403 | none |
| `GET /api/media-servers/:id` | `Read Settings`| path `id` | 200 `MediaServerRow` | 400 numeric; 404 `MediaServer #<id> not found` | none |
| `PUT /api/media-servers/:id` | `Manage Settings`| path `id`; the SAME `CreateMediaServerDto` (`name`, `type`, `url` stay required, rule 2) | 200 `MediaServerRow` | 400; 404 as above | UPDATE `media_servers` |
| `DELETE /api/media-servers/:id` | `Manage Settings`| path `id` | 200, empty body | 400; 404 | DELETE `media_servers` |
| `POST /api/media-servers/:id/test` | `Manage Settings`| path `id`, no body | 201 `{ok: boolean, message: string}` (rule 8) | 400; 404; remote failures are 201 `ok:false` | one `GET {url}/System/Info` |
| `POST /api/media-servers/:id/import-watch-history` | `Manage Settings`| path `id`, no body | 201 `{ok: true}` immediately; result by SSE (rules 20-21) | 400; 404 `MediaServer #<id> not found`; 404 `Watch-history import is only supported for Emby servers` (type != emby); 409 `Import already running` | INSERT `commands`; INSERT `users`, UPSERT `playback_states` |

`GET /types` is declared before `/:id` (a static segment always wins in axum, so no ordering rule is needed).

## Rules

### A. CRUD

1. `CreateMediaServerDto`: `name` string (required, empty allowed, no uniqueness), `type` one of `local|jellyfin|emby|plex` (required), `url` string (required; an http(s) URL with a host, else 400 `url must be a URL address`, checked only when it differs from the stored one on a PUT, rule 7), `apiKey?` string, `events?` string[] each one of the row's `type` supported events, rule 9, none for a type without provider; else 400 `each value in events must be one of the following values: <list>` or `type <type> supports no events`; checked on create and on a PUT whose events or type differ from the stored row, rule 7), `enabled?` boolean. `null` is accepted for `apiKey`, `events` and `enabled` on create (rule 2) and, for `apiKey` only, on update (rule 3). No implicit conversion: `"true"` for `enabled` is 400.
2. `create`: row `{name, type, url, apiKey: dto.apiKey or '', events: dto.events or [], enabled: dto.enabled or true}` (a `null` becomes `''`/`[]`/`true`); the response carries every column (`id`, `createdAt`, `updatedAt` from the INSERT). The column `apiKey` is nullable: a PUT with `apiKey: null` stores NULL (rule 3), and that row answers `apiKey: ""`, `apiKeySet: false`.
3. `update`: 404 when the row is missing; then each field is assigned only when present (the DTO makes `name`, `type`, `url` mandatory, so in practice `apiKey`, `events`, `enabled` are the optional ones; `type` is editable). An absent `apiKey` keeps the stored key, and so does `""`; only a non-empty string replaces it and `null` clears it (stores NULL). `events: null` or `enabled: null` is 400 with the standard validation body (POST keeps rule 2's defaults). The response is the updated row (`updatedAt` refreshed). Read then write, no transaction.
4. `remove`: 404 when missing, else DELETE; 200 with an empty body. No cascade (nothing references the table).
5. `GET /types` = the registered providers (`emby` only), `{type, label, supportedEvents}` per provider in registration order.
6. List order: `ORDER BY name ASC` in byte order, then `id ASC` as the tie-break (parity compares the list order-insensitively like `/api/settings`).
7. Validation on write (rules 1 and 9): a PUT checks only what it changes, because a 4.x client's `toggleEnabled` re-sends the stored `url` and `events` and a row stored before this validation may hold values it refuses. Migration `1787200000000_media_servers_normalise_url_events.sql` cleans the stored rows once: a url without a `scheme://` gets `http://` (the form's placeholder scheme; such a url never connected, the request builder rejects it), `events` keep only the type's supported events (a type other than `emby` has none). A url with another scheme, or an empty one, is left as is and stays editable by toggle only. `apiKey` is stored as is and never serialised; server-side consumers (rules 8, 14, 15, 22) read the row as stored.
8. `testConnection(id)`: 404 when the row is missing; a `type` with no provider (`jellyfin`, `plex`, `local`) → 201 `{ok:false, message:'Type "<type>" non supporte'}` (French, no accent); Emby: `GET {url minus ONE trailing '/'}/System/Info` with header `X-Emby-Token: <apiKey>`, timeout 15 s: 2xx → `{ok:true, message:"Connecte a <ServerName ?? 'Emby'>"}` (no accent), any error incl. non-2xx → `{ok:false, message:<error message>}` (free text, parity compares `ok`).

### B. Library refresh dispatch (called by other modules, no HTTP route)

9. Emby `supportedEvents` = `download.complete`, `subtitle.downloaded`, `subtitle.upgraded`, `subtitle.synced`, `file.deleted`, `media.deleted`, `library.rescan`, in that order.
10. `dispatch(event)`: read every row with `enabled = true`; keep those whose `events` array contains `event` (exact string); none → return. For the rest, concurrently, the provider of the row's `type` (no provider → skipped silently) calls `refreshLibrary(url, apiKey)`. A failure is logged `Failed to dispatch <event> to <name>: <message>` and swallowed; a failure of the initial SELECT is logged and dropped too.
11. Emby `refreshLibrary`: `POST {url minus ONE trailing '/'}/Library/Refresh`, null body, header `X-Emby-Token`, timeout 30 s. A full library refresh per event; no path is sent. Info log `Emby library refresh triggered on <base>`.
12. Callers and their event (callers call `media_servers::dispatch(&state, event)` directly; every call is fire-and-forget, `tokio::spawn`): `media.deleted` and `file.deleted` (media delete / file delete, media spec); `library.rescan` (rescan, disk import); `subtitle.synced`; `subtitle.downloaded` / `subtitle.upgraded`; `download.complete`.

### C. Watch-history import (`POST /api/media-servers/:id/import-watch-history`)

13. Order of checks: the row (404 `MediaServer #<id> not found`), then `type !== 'emby'` → 404 `Watch-history import is only supported for Emby servers`; then the running-import check (rule 23, 409); then the lifecycle of rule 20.
14. Emby calls (header `X-Emby-Token`, base = url minus ONE trailing `/`, path segments percent-encoded): `GET /Users` (timeout 30 s; an empty body is zero users) = `{Id, Name}`; `GET /Users/<userId>/Items` with query `IncludeItemTypes=Movie,Episode`, `Fields=ProviderIds,UserData,ParentIndexNumber,IndexNumber,SeriesName,SeriesId,RunTimeTicks,DateCreated,PremiereDate`, `Recursive=true`, `StartIndex`, `Limit` (500), plus `IsPlayed=true` (mode `played`) or `IsResumable=true` (mode `resumable`), timeout 60 s; mode `resume` uses `GET /Users/<userId>/Items/Resume` with the same query minus the flags; `GET /Users/<userId>/Items/<itemId>` (timeout 30 s; any failure → null). Page response `{Items, TotalRecordCount}`: `[]` / 0 when absent.
15. `importForServer`: a non-Emby server is a 404 (guarded earlier); a `listUsers` failure pushes `listUsers failed: <message>` to `stats.errors`, and the import ends as failed (rule 27). Otherwise per Emby user, sequentially, each in its own try/catch (a failure pushes `user "<Name>": <message>` to `stats.errors`, never sent to the client); totals: `users` (every Emby user seen), `usersCreated`, `imported`, `skipped`; `perUser` and `errors` stay server-side. Caches shared across users in the run: movie by TMDB id, series by TMDB id, series TMDB id by Emby `SeriesId` (misses cached as null).
16. User resolution: `users WHERE username = <Emby Name>` (exact, case-sensitive); absent → the default role (first `roles` row with `"isDefault" = true`, `ORDER BY id LIMIT 1`, may be none) and INSERT `{username, passwordHash: NULL, roleId: role id or NULL, mediaServerType: 'emby'}` (other columns default); `created = true`; the new user gets `library_user_access` rows for the default role's `defaultLibraries` (rule 24). An existing user keeps its `mediaServerType`. A `Name` of `''` is an ordinary username (matched or created as `''`); a missing or blank `Name` pushes `user "": missing name` to `stats.errors` and the user is skipped.
17. Per user, three sets are fetched fully before any write (pages of 500 until a page is empty or `offset >= total`; `offset += items.length`): `resume` (`/Items/Resume`, the authoritative Continue Watching queue; its Emby ids form `resumeIds`), `played`, `resumable`. Processing order resume, played, resumable; an Emby item id already seen is skipped (first occurrence wins). An item is skipped (`skipped++`, nothing written) when `UserData.Played !== true` AND `PlaybackPositionTicks` (default 0) is 0 AND it is not in `resumeIds`. Otherwise `applyItem` returns true (`imported++`) or false (`skipped++`); a throw counts `errors++` (per-user stat, warn log) and continues.
18. `applyItem` values: `resolvedDate = LastPlayedDate ?? DateCreated ?? PremiereDate ?? now` (each parsed as a date, an invalid value is skipped to the next), used for BOTH `lastPlayedAt` and `playedAt`; `positionSeconds = floor(PlaybackPositionTicks / 10_000_000)`; `durationSeconds = floor(RunTimeTicks / 10_000_000)` (0 when absent); `completed = inResume ? false : Played === true`; `hiddenFromContinueWatching = !inResume && !Played && PlaybackPositionTicks > 0`. A re-watch (Played and in the resume queue) is therefore not completed.
19. Matching (false = skipped, never an error): Movie: `ProviderIds.Tmdb` an integer >= 1 after trim (a fraction such as `'12.5'` or a non-number is false), then the media of kind `movie` holding that `tmdb` id (`external-ids.md` rule 6, cached); no row → false; the item is the movie's ungrouped item (none → false), state key `(userId, itemId)`. Episode (any other `Type`): `SeriesId` required; the series' TMDB id comes from `getItem(userId, SeriesId)` `ProviderIds.Tmdb` and must match `^\d+$` (else null, cached), `0`/null → false; the media of kind `series` holding that `tmdb` id (cached); `ParentIndexNumber` and `IndexNumber` both required; the episode is `episodes e JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = <series> AND s."number" = ParentIndexNumber AND e."number" = IndexNumber` (first row; a multi-episode file matches only by its first number); state key `(userId, itemId)` with the episode as item. The library ACL of the user is not applied.
20. Lifecycle and events (the route returns 201 `{ok:true}` before any of it): SSE `watch-history.import.started {serverId, serverName}`; (fire and forget) the audited command wrapper (`ImportWatchHistory`, `manual`): INSERT `commands {name, status:'running', trigger:'manual', startedOn}`, `command.started {name}`, run the import, UPDATE the row `completed|failed` with `endedOn`, `command.completed {name, status}`. The import: `importForServer(server)` then `watch-history.import.completed {serverId, serverName, users, usersCreated, imported, skipped}`; on a throw: log, `watch-history.import.failed {serverId, serverName, error: <message>}`, the wrapper marks the row `failed` and does not rethrow; it fails only when the INSERT fails (no `command.started`, nothing ran) or the final UPDATE fails (after `completed|failed` was already sent, no `command.completed`): both emit `watch-history.import.failed {serverId, serverName, error: ''}`.`serverId` / `serverName` are taken from the row read BEFORE the run. Client order: `started`, `command.started`, `completed|failed`, `command.completed`. All broadcasts (events-hub audience B).
21. `upsertPlaybackState(userId, mediaId, episodeId|null, positionSeconds, durationSeconds, lastPlayed, playedAt, completed, hidden)`: existing row = `playback_states` of `(userId, itemId)`. If it exists and its `lastPlayedAt` (NOT NULL, default `now()`) is strictly newer than `lastPlayed` → return false (Fliks wins: skipped). Existing, not newer: `positionSeconds`, `completed`, `hiddenFromContinueWatching`, `lastPlayedAt`, `playedAt` replaced, `durationSeconds` replaced only when the new value > 0; `mediaFileId` untouched; `updatedAt` refreshed; return true. Absent: INSERT all those columns (`durationSeconds` 0 when unknown, `mediaFileId` NULL); return true. The unique key `(userId, itemId)` guards it; the write is the single statement of rule 25.

### D. Security and robustness

22. No `ok:false` message, log, SSE `error` or `stats.errors` entry contains the request URL or its userinfo (shared with `importers.md` rule 37); `reqwest::Error` goes through `without_url()`. Redirects are followed only to the same host (`importers.md` rule 38): the `X-Emby-Token` never follows a `Location` to another host. Emby timeouts are as in rules 8, 11, 14.
23. A second `import-watch-history` for a server whose import is running is 409 `Import already running` (one in-process set of server ids, released on completion or failure), checked after the 404s and before `watch-history.import.started`.
24. A user created by the Emby import gets `library_user_access` rows for the default role's `defaultLibraries`, with the same transaction and unique-violation re-read as `importers.md` rule 42; a missing or blank Emby `Name` is skipped (rule 16). Without it the imported accounts cannot see any media.
25. The playback write is ONE statement: `INSERT INTO playback_states (...) VALUES (...) ON CONFLICT (...) DO UPDATE SET ... WHERE playback_states."lastPlayedAt" <= EXCLUDED."lastPlayedAt"` (one statement, conflict on `(userId, itemId)`), returning whether a row was written; `durationSeconds = CASE WHEN EXCLUDED."durationSeconds" > 0 THEN EXCLUDED."durationSeconds" ELSE playback_states."durationSeconds" END`. "Fliks wins" and the race with a live heartbeat are decided by the database.
26. `events: null` / `enabled: null` on PUT are 400 with the standard validation body (rule 3; POST keeps rule 2's defaults); `type` stays any of the 4 enum values.
27. A `listUsers` failure (rule 15) is reported as `watch-history.import.failed {serverId, serverName, error}` (command row `failed`), not as a `completed` event with zeros; per-user failures stay in `stats.errors`.
28. The Emby URL may be any host (SSRF accepted for admin-set endpoints); `type` of an existing row can be changed; importing with `enabled = false` works (the flag only gates `dispatch`).
29. `watch-history.import.*` and `seerr.import.*` are broadcast to every connected client (events-hub audience B; no secret in the payload); `dispatch` runs one full Emby library refresh per event, no debounce; `jellyfin`, `plex` and `local` are accepted by CRUD without a provider (test says unsupported, dispatch skips, import 404s), because restricting the enum on write would break the round-trip of stored rows through PUT; an imported user keeps `passwordHash NULL` and the admin sets a password through `PUT /api/users/:id`.

## SQL

1. CRUD: `SELECT * FROM media_servers ORDER BY name ASC, id ASC`; `... WHERE id = $1`; `INSERT INTO media_servers (name, type, url, "apiKey", events, enabled) VALUES ($1,$2::media_servers_type_enum,$3,$4,$5::jsonb,$6) RETURNING id, "createdAt", "updatedAt"`; `UPDATE media_servers SET name, type, url, "apiKey", events, enabled, "updatedAt" = now() WHERE id = $1`; `DELETE FROM media_servers WHERE id = $1`. Enum `media_servers_type_enum` = `local, jellyfin, emby, plex`; `events` jsonb default `[]`.
2. Dispatch: `SELECT * FROM media_servers WHERE enabled = true`; the `events` filter is done in code (`events ? $1` could replace it; same result).
3. Import users and roles: `SELECT * FROM users WHERE username = $1`; `SELECT r.id, r.name, rdl."libraryId" FROM roles r LEFT JOIN role_default_libraries rdl ON rdl."roleId" = r.id WHERE r."isDefault" = true ORDER BY r.id` (the join serves the default libraries of rule 24); `INSERT INTO users (username, "passwordHash", "roleId", "mediaServerType") VALUES ($1, NULL, $2, 'emby') RETURNING id`; `INSERT INTO library_user_access ("userId", "libraryId") VALUES ...`.
4. Matching: the media of kind `$1` holding the `tmdb` id `$2` (`external-ids.md` rule 6); episode: `SELECT e.* FROM items e INNER JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = $1 AND s."number" = $2 AND e."number" = $3 ORDER BY e.id LIMIT 1`.
5. Playback state (rule 25): `INSERT INTO playback_states ("userId","itemId","positionSeconds","durationSeconds",completed,"hiddenFromContinueWatching","lastPlayedAt","playedAt") VALUES ($1,$2,...) ON CONFLICT ("userId","itemId") DO UPDATE SET ... WHERE playback_states."lastPlayedAt" <= EXCLUDED."lastPlayedAt"`. `RETURNING id` empty = skipped.
6. Commands as in `importers.md` SQL 7 with `'ImportWatchHistory'`.

## Events

| Event | Audience | Payload | Emitter |
|---|---|---|---|
| `watch-history.import.started` | broadcast | `{serverId: number, serverName: string}` | `import-watch-history`|
| `watch-history.import.completed` | broadcast | `{serverId, serverName, users, usersCreated, imported, skipped}` | same|
| `watch-history.import.failed` | broadcast | `{serverId, serverName, error: string}`, `''` when the audit row could not be written | same|
| `command.started` / `command.completed` | broadcast | `{name:'ImportWatchHistory'}` / `{name, status}` | audit wrapper (rule 20) |

Consumed: the domain events of rule 12 are NOT consumed by this module: callers call `dispatch` directly. The CRUD routes and `dispatch` emit nothing. The SSE types are in `server/crates/server/src/events/event.rs`.

## Settings keys

None. Connection settings live in the `media_servers` table (`url`, `apiKey`, `events`, `enabled`), not in `app_settings`; `apiKey` is stored in clear and never returned (`apiKeySet` says whether one is stored).

## Jobs/timers

None scheduled. The import is fire-and-forget, audited as a `commands` row (`ImportWatchHistory`, trigger `manual`); the scheduler framework marks `running` rows `failed` at boot. `ImportWatchHistory` is in neither core job list, so `POST /api/commands` cannot start it. `dispatch` calls are one-shot tasks.

## Vectors/parity

No pure logic worth a vector set: the Emby mapping rules (rules 17-19) are small and covered by Rust unit tests built from recorded Emby payloads (`server/fixtures/media-servers/emby/*.json`: `Users`, `Items` pages for `Resume` / `IsPlayed` / `IsResumable`, series `Items/<id>`, `System/Info`): resume beats played beats resumable, re-watch not completed, hidden-from-resume, date fallback chain, tick conversion, episode matching by series TMDB id, newer-state skip, blank names, 500-item paging with `TotalRecordCount`.

External HTTP is mocked, never real: Rust tests start an in-process `axum` stub (random port) serving those fixtures (modes: ok, 401, 500, slow, cross-host redirect, `Users` failure); parity uses its own stub `server/parity/stubs/emby-stub.mjs` (no dependencies, port 4962) over the same fixtures; the first path segment is the mode (`ok`, `401`, `500`, `slow` (`/Users` waits 3 s), `redirect`, `nousers`, `big`) and the seeded `media_servers` rows point at `http://127.0.0.1:4962/<mode>`. `Library/Refresh` records its hits (`GET /__hits`, `DELETE /__hits`); the Rust dispatch tests read the in-process stub's hits instead. The blank-name case (rule 16) is a Rust test only.

Parity scenarios (`server/parity/scenarios/media-servers/`; seed: 2 media servers (one enabled with `events`, one disabled), movies/series with TMDB ids matching the fixtures, the default role): CRUD (`create`, `get`, `list`, `delete`, with 400/404 and authorization variants), `types`, `test-ok|bad-key|unsupported-type`, `import-history` (SSE step then `GET /api/playback/history` as the imported user), `import-history-rerun` (newer playback state skipped), `import-history-not-emby-404`, `import-concurrent` (409), `import-listusers-fails`, `import-user-library-access`, plus 401 and 403 (`readonly`, `user`) per route. Dispatch scenarios run through a Rust test (callers are internal): enabled + event match hits the stub once, disabled / non-matching / failing stub never errors.

## Deferred (issue)

None.

## Open questions

None.
