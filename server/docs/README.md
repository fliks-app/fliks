# Server docs

## Spec index

Per-domain specs land under [`spec/`](spec/) as milestones complete (template: phase-2 plan §12).

## Tag legend (in specs)

| Tag | Meaning |
|---|---|
| `[ts:path:line]` | Open that file at that line only (±40 lines). |
| `[new]` | Deliberate deviation from Nest; record here or in Deviations. |
| `[assumed]` | Behaviour inferred where Nest is unclear; verify before port. |

## Deviations

Decided behaviour for the Rust port (security fixes F, correctness fixes C; D3). Each lands in its owning milestone. Each has a parity exception.

| # | Today (Nest) | Rust behaviour | Client impact |
|---|---|---|---|
| F1 | `POST /api/auth/register` open to anyone | `register` requires `users.manage`, else 403. The `admin/password` seed on an empty users table stays (user decision 2026-10-15) | web client register screen (hide it for non-admins) |
| F2 | `GET /api/users/:id` readable by any user | self or `users.manage`; others 403 | client user pages (social profile uses `/api/social/users/:id/profile`) |
| F3 | `/api/images/*` public | **dropped (user decision 2026-10-15)**: images stay public (id-addressed, low sensitivity; most clients load them without a credential, see `client-audit.md`) | none |
| F4 | `/api/persons/*` public | authenticated | none expected |
| F5 | `GET /api/settings` and `GET /api/engine/remote` return secrets in clear | secret keys redacted with the existing redact/merge convention (`backend/src/common/utils/secret-fields.util.ts`); PUT with the placeholder keeps the stored value | admin settings pages |
| F6 | `refresh_tokens` never pruned | daily prune of expired/revoked rows older than 30 days | none |
| F7 | access token 1 h but cookie `maxAge` default 7 d | cookie `Max-Age` = token lifetime | none |
| F8 | `scope:'stream'` tokens (12 h, travel in URLs) accepted on every route without `SessionTokenGuard`: pairing approve, `PUT /users/:self {password}`, `stream-token` self-renewal, `cast-info` | the extractor rejects `scope:'stream'` (401) except on routes explicitly marked stream-allowed (media delivery routes, listed in the spec of the milestone that ports them; none in S1) | verify every client calls API routes with its access token (parity + client smoke) |
| F9 | password change revokes nothing | revokes every refresh-token family of the user and drops their SSE connections; the caller's access token stays valid until it expires | none |
| F10 | `users.manage` alone can set `isAdmin`, reset/delete an admin, delete the last admin | only an admin may set `isAdmin` or modify/delete an admin; the last enabled admin cannot be deleted, disabled or demoted (409) | admin user pages show the error |
| F11 | a user can raise their own quota fields | quota fields writable only with `users.manage` | none |
| F12 | `roles.manage` can store any permission string, incl. `manage:all` | permissions a request adds (not already on the role) validated against `GET /roles/permissions`; granting `manage:all` requires admin | none |
| F13 | `pairing.requested` broadcast to every SSE client | sent only to the target user's connections | none |
| F14 | polled remote targets keyed by `deviceId` only (another account takes them over) | keyed by `(userId, deviceId)` | none |
| F15 | an approved pairing stays claimable after `expiresAt` until the hourly cleanup | claim checks `expiresAt`: an unclaimed approval past it is flipped to `expired` and polls answer `{status:"expired"}` | none: clients already stop on `expired` |
| F16 | Nest accepts HS256, HS384 and HS512 and a token without `exp` (valid forever) | only HS256 is accepted and `exp` is required: a token without `exp` or signed HS384/HS512 is 401; Fliks only ever signs HS256 with `exp` | none |
| F17 | a deleted user's open SSE connections stay open | dropped on delete | none |
| F18 | logout left the refresh token valid, and a replay after the 30 s grace revoked nothing: both revokes matched `"revokedAt" = NULL` | logout revokes the presented refresh token; a replay revokes every live refresh token of the user | none |
| F19 | a library `path` may be relative and `mkdir -p` ran before the conflict and in-use checks, leaving directories behind on a 400 | `path` must be absolute (400); conflict and in-use checks run first, `mkdir -p` is the last step before the `UPDATE` | none |
| F20 | `GET /api/libraries/:id` and `:id/access` ignored the library ACL; `PUT :id/access` on an unknown library answered 200 or 500 | the ACL applies to both reads; unknown library → 404 `Library #<id> not found` | none |
| F21 | an image `variant` such as `..%2F..%2Fx` reached `path.join`: any readable `*.jpg` fetched anonymously | `variant` must match `^(poster\|fanart\|fanart-[0-9]+\|logo)$` for media and request art, else 404 | none |
| F22 | absolute server paths (`Media.path`, `library.path`, `disk`, playlist items' `media.path` and `media.library.path`) were serialised for every reader (`media.read`, library readers) | present only for callers who can manage libraries (`settings.access` or `manage:all`); omitted otherwise on `GET /api/media`, `recently-added`, `GET :id`, `/api/libraries*`, `/api/roles` and playlist items | client readers use `m.path ?? null` (see `client-audit.md`) |
| F23 | `GET /social/users/:id/followers` and `/following` ignored `shareDisabled` and listed disabled users | the profile gate (an opted-out viewer or target, non-self, answers 404 `User #<id> not found`); disabled users are omitted | none |
| F24 | popular among followed counted every followed user's completions | only followed users with `shareWatchHistory` | none |
| F25 | profile `topGenres` came from the target's whole history | restricted to the viewer's accessible libraries | none |
| F26 | a saved playlist its owner made private stayed in the saver's list | dropped from `GET /playlists` once it is no longer readable | none |
| F27 | adding an opted-out member answered 403, a missing one 404 | both 404 `User #<id> not found` | none |
| F28 | `settings.webhookUrl` of Discord/Slack notification connections returned in clear (the URL embeds its credential) | secret field like `token`: omitted from responses, listed under `secretsSet`; a blank or absent value on write keeps the stored one, `null` is a 400 (the URL is required, so it is replaced, never erased); a type switch drops it | notification editor shows the masked "set" state |
| F29 | gotify token (query string) and webhook URL could reach sender errors, logs and the `test` response; the same for the importers' and media servers' URLs (userinfo, API-key hosts) in errors, logs and SSE | sender, importer and media-server errors, logs and SSE never contain the request URL or its userinfo | none |
| F30 | Discord payloads allowed `@everyone`/role/user mentions from request titles | Discord body adds `allowed_mentions: {parse: []}` | none |
| F31 | remote state/stopped fan-out reached grantees of a device id under any owner (anyone could mint a code for another user's deviceId and receive its playback state) | fan-out limited to grants whose owner is the device's owner | none |
| F32 | `POST /api/likes` and `POST /api/social/recommend` accepted a season/episode of another media and media outside the caller's libraries (201) | 404 `Media\|Season\|Episode #<id> not found`, as for unknown ids (user decision 2026-10-16) | none |
| F33 | `social/requests`, the recommendation cards and the follow lists listed opted-out (`shareDisabled`) and disabled members | they are omitted from every social list (the F23 filter, one predicate; `social.md` rule 57; user decision 2026-10-16) | none |
| F34 | `GET /api/social/users/:id/stats` returned the target's last login (`activity.lastActiveAt`) to any viewer allowed by `shareStats` | `lastActiveAt` omitted for a non-self viewer; request counts stay under `shareStats` (`social.md` rule 58; user decision 2026-10-16) | none: the profile Statistics tab does not read it |
| F35 | profile `followerCount`/`followingCount` counted disabled and opted-out members that the follow lists omit | both counts exclude them (the F33 predicate, `social.md` rule 59; user decision 2026-10-16) | none |
| F65 | data-tier plugin webhook delivery resolves the host, checks it, then the HTTP client resolves again (DNS rebinding window) | resolve once, connect to the vetted address, same connector as F58 | none |
| F66 | plugin webhook targets and catalog source URLs appear in logs, `failures[]` and `lastRefreshError` | no URL, userinfo or query in any of them (error kinds only) | none |
| F67 | process plugins reach any address, internal included | plugin outbound HTTP refuses internal addresses unless the plugin holds the `network.internal` grant given at install consent (link-local, reserved, 6to4, Teredo and documentation ranges stay refused) | install sheet lists the new capability `network:internal`, shown raw until a client i18n key exists |
| F68 | plugin `config.get` without keys returns, and `config.set` writes, every `plugin.<id>.*` key, including those of a plugin whose id extends it (`fliks` reads `fliks.download` secrets); the `hello` config too | only keys whose longest installed owner id is the caller; a `config.set` of another owner's key is `ERR_DENIED` | none |
| F36 | backup routes (create, list, download, restore, delete) need `settings.access` only, so a dump (every password hash and secret) bypasses F5 and a restore can overwrite `users` | the five backup routes need `manage:all`; health, stats, update, logs and restart keep `settings.access` | the backups page is admin-only (other `settings.access` callers get 403) |
| F37 | restore runs `psql -f` over a file that may hold `\!`, `\i` or `\copy ... PROGRAM` | `psql -X`, and a line-start screen: a line outside a `COPY ... FROM stdin;` block that starts with a backslash (except `\restrict <key>`, `\unrestrict <key>`, `\.`) is 400 `Backup contains psql meta-commands`. Best effort only, not a SQL lexer: a meta-command after `;` on the same line, or text inside a multi-line string literal, is not seen. The file is not uploadable (the directory belongs to the data volume owner), so the screen guards against a stray file, not a hostile one | none |
| F38 | backup files `0644` | files `0600` in a `0700` directory | none |
| F39 | no rule about credentials in logs | the HTTP trace logs method and path only (no query string); `reqwest` errors are logged without their URL | none |
| F40 | `existingMediaId` of the metadata lists, and the credits `mediaId` and cast/crew media of persons, exposed media of libraries the caller cannot read, with their absolute paths | only media in libraries the caller can read (others: `existingMediaId` / `mediaId` `null`, cast/crew rows omitted); `path` and `library.path` only for callers who can manage libraries (F22) | none expected |
| F41 | the stored importer API key (`radarr_api_key`, `sonarr_api_key`, `seerr_api_key`) was used for any body `url` | used only when the body `url` equals the stored `*_url` setting (trailing `/`, scheme and host case ignored); otherwise 400 `apiKey is required` | the data-imports page omits the key only for the saved URL; an edited, unsaved URL needs the key retyped |
| F42 | importer and media-server requests followed redirects to any host, carrying `X-Api-Key` / `X-Emby-Token` | a redirect is followed only to the same host (limit 5), any other is a plain failure | none |
| F43 | `GET /api/markers/episode/:id` and `season/:id` answered any id with `[]` and no library check | the library ACL of the media routes applies; an unknown or inaccessible episode or season is 404 | none (the only reader swallows errors) |
| F44 | a `folderName` of `..`, `.`, `''` or one with a separator, from a provider title, the relink body or a naming format, made the media path the library's parent or root (ingest, rescan and delete then acted outside the title) | one `fliks_domain::naming` validator on every writer (TMDB/provider import, relink, `createUnmatched`, the `confirmImport` pin, Radarr/Sonarr path mapping: an `errors` entry `<title>: invalid folder name for "<path>"`): 400 or an `errors[]` entry, nothing written; computed season folders and file names are single components (video extension, 255 bytes) | none |
| F45 | media folder, file, superseded-file and companion deletes joined unvalidated DB text (lexical check only): symlinks, `..` and nested library roots were followed | `realpath` containment under the library root; a symlink is unlinked, never followed; `relativePath` with `..`, NUL or absolute → 400 `Invalid file path`, row kept | none |
| F46 | write routes trusted ids: import into any library, `PATCH :id/library` to any library, `bulk` on any media, episode refresh of another media's episode | the caller's library ACL: unknown or inaccessible library/media → 404 (as F32), `bulk` all or nothing | none |
| F47 | in-place relink registered any file the process could read (`folderName = ../../etc`), a move relocated a symlink into the library, an in-place `reorganize` moved any writable file | contained, regular video file, sources resolved through symlinks; `reorganize` without `transfer` only moves files under the library root (else an `errors[]` entry) | none |
| F48 | disk-import routes: no library ACL on `orphans/scan` and `relink` (and the path returned to anyone), `preview` and transfers read any directory | `scan` and `relink` apply the library ACL (404), F22 on `libraryPath`; `preview` and relink with `transfer` need `settings.access`; relative `preview` paths 400 | none (the wizard is admin-only) |

Not done (user decision 2026-10-15): login rate limiting/lockout.

Deviation details (decided 2026-10-15): F1 anonymous → 401 (auth runs before the handler), authenticated
without `users.manage` → 403. F2/F10/F11 403 body = Nest's default `ForbiddenException` body (as recorded by
parity). F5 uses the existing `secret-fields.util.ts` convention (secret keys omitted from GET and listed in
`secretsSet`; blank on write keeps the stored value, `null` clears). Secret keys: `engine_token`, the
`subtitle_translation_*_api_key` keys, `seerr_api_key`, radarr/sonarr API keys, plugin config fields marked
secret; `GET /api/settings/:key` on a secret key returns `value: null` + `secretSet`. Client pages to adapt
are listed in `client-audit.md`. F6 prune runs daily at 03:30. F7: one parser for `JWT_EXPIRATION`
(Nest's `ms()` grammar, a bare number is milliseconds, documented in `config.md`); cookie `Max-Age` = that
lifetime in seconds.

### Correctness

A 500 or a half-written request is never part of the frozen contract:

| # | Today (Nest) | Rust behaviour |
|---|---|---|
| C1 | 500 on unvalidated input: non-integer or out-of-int4 media filters, `page < 1` with `limit > 0`, negative `recently-added` `limit`, calendar dates Postgres rejects, a `sortBy` naming an `Object.prototype` member (falls back to `title`), `streams` on a library without path (404); library create with a duplicate name, update with a null name, access set with an unknown user; `GET /api/remote/commands` without `targetId`, fractional `page`/`limit` on history, non-numeric `startAt` on playback-info, `null` on non-nullable user fields, `null` `events`/`enabled` and ids beyond int4 on notification connections; `toggle-watched` and season `toggle-watched` on an unknown media; non-canonical `page`/`limit` on `GET /api/commands`, non-canonical `limit` on `GET /api/system/logs` (accepted by Nest as `1.5`, `1e1`, `0x10`) | 400 with the standard validation body; unknown media → 404 `not_found` |
| C2 | writes before failing: bulk `PUT /api/settings` stops at the first protected key; non-manager `PUT /users/:id` with `libraryIds` saves the rest then 403s; `PUT /quality-definitions` updates item by item | validate and authorise the whole request first, write in one transaction |
| C3 | refresh rotation and pairing claim are not atomic | one transaction with `SELECT … FOR UPDATE` |
| C4 | recommendations ties follow Postgres scan order | score desc, then media id asc |
| C5 | a superseded SSE connection leaves its socket open | the server closes it |
| C6 | playback-info 500s after creating the session when the markers query fails; `toggle-season-watched` does not check the season belongs to the media | markers failure is logged and playback proceeds without markers; season not under the media → 404 |
| C7 | static client, `/cast` and images: weak ETag from the mtime in ms, `; charset=UTF-8` on text types, `Vary: Origin` only, bare OPTIONS → 204; a missing `/cast/*` file answers 404 with an ENOENT message leaking the absolute path | ETag from mtime in seconds, tower-http `Vary`, bare OPTIONS → 404; missing `/cast/*` → 404 `Cannot GET <url>` (no path leak). Browser-cache only: one re-download per file after the upgrade |
| C8 | raw-SQL / explicit updates did not touch "updatedAt" (series watched toggles, search vector refresh, leave-social playlist privacy, live TV group stamp/renumber) | a BEFORE UPDATE trigger sets "updatedAt" = now() whenever an UPDATE leaves it unchanged (migration `1786500000000_updated_at_trigger.sql`); playlists made private on leave-social move up in the owner's home row |
| C9 | image ids coerced by unary `+` (`007`, `0x7`, `7.0`, ` 7 ` served id 7) | canonical integers only, else 404 |
| C10 | `GET /api/media?q=` ordered by the requested sort (default title) because `orderBy` replaced the relevance order | `q` without `sortBy` orders by FTS rank desc (NULL rank last), then title, then id; the search page now omits `sortBy` unless the user chose one |
| C11 | `cutoffUnmet=true` removed items from the already paginated page (short pages, `total` unchanged) | filtered in SQL before pagination: `page`, `limit` and `total` count only the media that pass |
| C12 | equal sort keys left list order to the database (media list, recently-added, collections, similar, collection, cast, crew, calendar, files, seasons, episodes; libraries, `userIds`, follow lists, likes state, playlist members; scheduler `commands` list, last-run lookup and job input scans) | every list ends with `id ASC` (`id DESC` for the newest-first `commands` list and last-run lookup) |
| C13 | `GET /playlists/:id` (and the create/patch views) reported `viewer` for an editor or administrator share on a public or followed playlist | the real share role |
| C14 | playlist reorder/add validated outside their transaction; the leave-social teardown ran as six unrelated statements | validation and writes in one transaction under a row lock on the playlist (add computes `MAX(position)+1` under it); the teardown in the transaction of the user update |
| C15 | social search ordered by the database collation before `LIMIT 30` | `lower(username)` bytewise, then `id` |
| C16 | notification senders had no timeout (axios `timeout: 0`) | 10 s total per request, no retry; `test` reports `timeout of 10000ms exceeded` |
| C17 | a plugin-supplied event outside the notification vocabulary was dispatched (default message) | rejected with 400 before any sender runs |
| C18 | `POST /api/system/streams/:sid/command` with an `action` outside pause/play/stop/message was relayed to the client as is | 400 |
| C19 | live TV rows of `/api/system/streams` reported the source's name as `quality` (`"Live"` only without one) | they report `"Live"` |
| C20 | ValidationPipe coerced ` 7 `, `1e1`, `0x10` before `ParseIntPipe` | integer path segments must be canonical (`7`, `-7`; never `007`, `+7`, ` 7 `, `0x7`) on every Rust route: `PathParams` / `int_param` → 400 |
| C100 | concurrent install, upgrade, enable, disable, restart, uninstall, import, auto-update of one plugin id race (unique-index 500) | one at a time per plugin id |
| C101 | `PUT /plugins/sources/:id` that changes `url` or `publicKey` keeps the old `cachedCatalog` | cleared with `lastRefreshedAt` and `lastRefreshError` |
| C102 | plugin import writes the tables, then refuses an out-of-scope settings key; an unknown table or column is a 500 | every check before any write; an unknown table or column is 400 `PLUGIN_EXPORT_MALFORMED` |
| C103 | plugin import inserts tables in alphabetical order, so `fliks.download` (`indexer_stats` before `indexers`) fails on its foreign keys | tables inserted in foreign-key dependency order |
| C104 | plugin ids `ui`, `metrics`, `sources`, `import` install and are then shadowed by the concrete routes | refused with `PLUGIN_BAD_ID` |
| C105 | a proxied plugin call that times out (504) leaves the plugin process running | the instance that ran it is dropped and the timeout counts toward the circuit breaker |
| C106 | a plugin route that a core route shadows (`GET /logo`, `GET /export`, `POST /import`, `/enable`, `/disable`, `/restart`, `/events/test`) is accepted and unreachable | refused at registration (`invalid-route-path`) when its path is literally one of them; param and splat patterns stay legal |
| C107 | the catalog `zipUrl` fetch follows no redirect, so a GitHub Release asset cannot install | follows https to https redirects, at most 5 hops; the first hop and hops to the `zipUrl` host stay trusted as in Nest, a hop to another host goes through the outbound guard; the signed sha256 stays the gate |
| C108 | a process plugin has no network grant (it reaches any address) and an upgrade needs no consent for it | an upgrade from a `pluginApi` 1 package with the same id and `verifiedByKeyId` carries `network.internal` forward and auto-update installs it; any later new request fails closed |
| C109 | Postgres unreachable during a plugin's start or health is a crash: ladder, breaker `failed`, admin restart | not a crash and not counted: the plugin is `degraded`, retried with backoff, `ready` again when the database returns |
| C118 | a plugin `health` call that times out is a miss: 2 misses degrade the plugin, 4 kill and restart its process | a timed-out or trapped `health` has lost its store and is a crash at once (ladder, breaker); the 2 and 4 miss rule applies only to `ok:false` replies |
| C119 | per-plugin Postgres roles are `plugin_<id>`, cluster-wide: two Fliks databases on one server share a role and provisioning one rotates the other's password; plugin ids up to 56 chars | role `fp_<database oid as 8 hex>_<id>`, scoped per database by its `pg_database` OID; the first Rust registration adopts the Node-era role's schema and drops the role unless another database uses it; a restore or a copy of the database takes the new database's names over; plugin ids over 51 chars are refused (`PLUGIN_BAD_ID`) |
| C33 | a Radarr title with `tmdbId` 0 or null was imported; Sonarr fell back to `tvdbId` as a TMDB id | imported only with `tmdbId` an integer >= 1 (else `invalid tmdbId`); no `tvdbId` fallback; Sonarr v3 (no `tmdbId` anywhere) is 400 `Sonarr v4 or later is required (the series list carries no tmdbId)` | none |
| C34 | importer calls had no timeout | 15 s test and title lookup, 60 s lists, 30 s per `extrafile` | none |
| C35 | two Seerr imports could run at once | the second is 409 `Import already running`, before `seerr.import.started` | the page toasts the message |
| C36 | Seerr: the user was created before the TMDB id check, the last requester claimed `addedById`, a `delete`-kind request could be matched, user and access rows were not transactional | TMDB check first (no user, not counted), first requester keeps `addedById`, only `kind = 'add'` rows match, user and `library_user_access` in one transaction | none |
| C37 | Radarr/Sonarr `importSubtitles` never wrote a row (TypeORM `mediaFileId` trap) and `update` mode always failed on `qualityProfileId`, which new rows also lost | subtitle rows are written (Radarr language names mapped to ISO 639-1), `update` mode updates, and `qualityProfileId` is stored | `subtitlesImported` counts real rows; imported media keep their mapped profile |
| C38 | a 2xx `rootfolder`/`movie`/`series` body Nest cannot walk was a 500 | 400 `Cannot connect to <Radarr|Sonarr>: <decode error>` | none |
| C39 | `POST /api/markers` was a delete then an insert (500 for an unknown episode, a new id) and detection persisted per segment without a transaction | one `INSERT ... ON CONFLICT` upsert keeping the row id; unknown episode 404; detection never overwrites a manual marker | none |
| C40 | `introMaxLookupMinutes` / `introMinSegmentSeconds` mapped only `0` and `NaN` to the default | fall back to 10 and 15 unless finite and > 0 | none |
| C41 | `POST /api/markers/series/:mediaId/detect-all` on an unknown media answered `[]` | 404 `Media #<id> not found` | none |
| C42 | two `import-watch-history` runs for one server could overlap | the second is 409 `Import already running` | the page toasts the message |
| C43 | users created by the Seerr (and Emby) import saw no library (Emby) or were written without a transaction (Seerr) | the default role's default libraries are granted in the user's transaction; a username collision re-reads the winner | none |
| C44 | the Emby playback write was a read, compare and write | one `ON CONFLICT ... WHERE lastPlayedAt <=` statement; the database decides that Fliks wins | none |
| C45 | an Emby `Users` failure ended in a `completed` event with zeros | a `watch-history.import.failed` event, command row `failed` | the page shows the failure |
| C21 | manual `RefreshPluginSources` had no dispatch branch: the row went `completed` having done nothing | runs the catalog refresh and the plugin auto-update (through `jobs/run` until S8) |
| C22 | two commands with one name could run at once | a command already `queued`/`running` in this process: manual `POST /api/commands` is 409 `Command "<name>" is already running`, a cron tick is skipped with a warning |
| C23 | `POST /api/system/restore` with a one-element string array `filename` ended in a 500 | any non-string `filename` is 400 `Invalid backup name "<String(value)>"` |
| C24 | a restore ran while commands were running, and the dump of a scheduled backup holds its own `running` row | 409 `A command is running` while a `commands` row is `queued`/`running`; after a restore every such row is marked failed |
| C25 | `GET /api/system/health` answered 500 when the database was down (the plugin counts threw) | 200 with `database.ok: false` and both plugin counts `0` |
| C26 | `pg_dump` / `psql` took `PGPASSWORD` with an empty default while the pool defaults to `fliks` | the connection values come from the one parsed `Config` the pool uses |
| C27 | one ledger (TypeORM's, inside the dump) | after a restore the legacy-ledger adoption and the pending sqlx migrations run, so an older dump gets today's schema |
| C28 | `/api/metadata/*` and `/api/persons/*` input and upstream failures: a repeated `q` and every upstream error on a list, discover, detail or credits route answered 500; `007` or `abc` ids reached the provider as `7` / `NaN` | repeated `q` 400; integer ids canonical (C20) 400; upstream 404 on a detail route 404; breaker open, timeout, 5xx or TMDB 401 503 `Metadata request failed on <provider>: <reason>`; a cold list with no stale copy 503 |
| C29 | TVDB had no breaker, an unbounded login that was not shared between concurrent first calls and no recovery from a revoked token | same 3 failures / 30 s breaker as TMDB; one login shared by concurrent calls (15 s timeout); one re-login on a 401 |
| C30 | person search words reached `to_tsquery` as syntax: `a&` or `(` answered 500, `a\|b` and `!a` were read as operators | each word is reduced to its letter, digit, `-` and `_` runs, quoted as a prefix lexeme and ANDed; a `q` with no usable word answers `[]` |
| C31 | person refresh and credits: a response with provider `null` birthday, death day or place omitted the key and kept the pre-update `updatedAt`; a provider pin that broke `UNIQUE(provider, tmdbId)` skipped the whole refresh; credits matched owned media on the id alone (a movie and a series sharing a TMDB id linked to the wrong one); a renamed person stayed indexed under the old name | the refreshing request answers the re-read row; the pin conflict keeps the row's provider and still serves the data; credits link on `(type, id)`; a trigger keeps `searchVector` in step with `name` (GIN index added) |
| C32 | image store: a second store of one target with another source got the first call's path; a failing sidecar write rejected the promise; a failed resize left the previous image's variants | the second call waits and then stores its own source; a sidecar failure answers `None`; each variant is removed before a re-store |
| C33 | a Radarr title with `tmdbId` 0 or null was imported; Sonarr fell back to `tvdbId` as a TMDB id | imported only with `tmdbId` an integer >= 1 (else `invalid tmdbId`); no `tvdbId` fallback; Sonarr v3 (no `tmdbId` anywhere) is 400 `Sonarr v4 or later is required (the series list carries no tmdbId)` |
| C34 | importer calls had no timeout | 15 s test and title lookup, 60 s lists, 30 s per `extrafile` |
| C35 | two Seerr imports could run at once | the second is 409 `Import already running`, before `seerr.import.started` (client: the page toasts the message) |
| C36 | Seerr: the user was created before the TMDB id check, the last requester claimed `addedById`, a `delete`-kind request could be matched, user and access rows were not transactional | TMDB check first (no user, not counted), first requester keeps `addedById`, only `kind = 'add'` rows match, user and `library_user_access` in one transaction |
| C37 | Radarr/Sonarr `importSubtitles` never wrote a row (TypeORM `mediaFileId` trap) and `update` mode always failed on `qualityProfileId`, which new rows also lost | subtitle rows are written (Radarr language names mapped to ISO 639-1), `update` mode updates, and `qualityProfileId` is stored (client: `subtitlesImported` counts real rows; imported media keep their mapped profile) |
| C38 | a 2xx `rootfolder`/`movie`/`series` body Nest cannot walk was a 500 | 400 `Cannot connect to <Radarr\|Sonarr>: <decode error>` |
| C39 | `POST /api/markers` was a delete then an insert (500 for an unknown episode, a new id) and detection persisted per segment without a transaction | one `INSERT ... ON CONFLICT` upsert keeping the row id; unknown episode 404; detection never overwrites a manual marker; the 201 body is the `Marker` shape (`episodeId`, no `episode` object) |
| C40 | `introMaxLookupMinutes` / `introMinSegmentSeconds` mapped only `0` and `NaN` to the default | fall back to 10 and 15 unless finite and > 0 |
| C41 | `POST /api/markers/series/:mediaId/detect-all` on an unknown media answered `[]` | 404 `Media #<id> not found` |
| C42 | two `import-watch-history` runs for one server could overlap | the second is 409 `Import already running` (client: the page toasts the message) |
| C43 | users created by the Seerr (and Emby) import saw no library (Emby) or were written without a transaction (Seerr) | the default role's default libraries are granted in the user's transaction; a username collision re-reads the winner; an Emby user without a `Name` (or a blank one) is skipped |
| C44 | the Emby playback write was a read, compare and write | one `ON CONFLICT ... WHERE lastPlayedAt <=` statement; the database decides that Fliks wins (new `playback_states` ids can skip values) |
| C45 | an Emby `Users` failure ended in a `completed` event with zeros | a `watch-history.import.failed` event, command row `failed` (client: the page shows the failure) |
| C46 | a title such as `Money $$$` or `Cash $& Carry` was rewritten by `String.replace` replacement patterns when it filled a naming token (`$$` became `$`, `$&` inserted the token) | values are substituted literally: the title is never rewritten (`naming.md` rule 9) |
| C47 | `PATCH /api/media/bulk`: no validation (fractional ids, unknown profiles = FK 500, `libraryId` = 500) | non-empty integer ids, unknown profile 404, `libraryId` as `PATCH :id/library` (400 when a media has files), one transaction |
| C48 | `onMediaRemoved` wrote before the media DELETE, outside any transaction | hook writes and the DELETE in one transaction |
| C49 | a media delete removed a folder shared with another media or containing a nested library root | such a folder is kept (`WARN`, SSE `media.files.delete_failed`), the row still goes |
| C50 | a failing season left a partial media after a TMDB import | media, seasons and episodes in one transaction, provider reads first |
| C51 | rescan created a missing media folder (even the library root) and then deleted every file row | 400 `Media folder not found: <dir>`, nothing touched; a failed `readdir` skips the removals; a media with no rows answers zeros |
| C52 | transfers replaced an existing destination (check-then-rename races, `(99)` overwritten, companions of the same name), a file at its own layout path was renamed `(2)` | no-replace renames (`renameat2`/link), `AlreadyPresent` on a lost race, `(99)` taken is an error entry, source equal to destination is linked in place, a companion claimed by a longer-named video is skipped |
| C53 | `confirmImport` re-pinned a media of another library and persisted a pin the ingest then refused; a dest outside the media folder was skipped silently | pin only when the media has no library, computed names validated first, every skip is an `errors[]` entry |
| C54 | ingest, rescan, link in place and deletes of one media interleaved freely | one in-process async lock per media id around each |
| C55 | rescan and orphan scan took any entry named `*.mkv` (FIFO, socket); the `.nfo` read had no cap | regular files only; `.nfo` capped at 1 MiB (NFO reader) |
| C97 | on a DST-change day `cron-parser` skips or shifts some local fires (`0 04 * * *` Paris on 2026-03-29 never fires) | `croner` fires every valid local time, so `nextRun` of `GET /api/commands/schedulers` and the real fires differ from Nest on those days only |
| C98 | `pg_dump --clean` only drops the objects the dump knows, so an older dump failed on the objects a later migration added (500, rolled back) | the replay's transaction first drops `public` and every `plugin_*` schema and recreates `public`: the restore replaces the whole database content (also the plugin schemas the dump lacks), then the migrations run |
| C99 | `dropSeasonsAbsentFromProvider` with an empty provider season list (a failed or truncated fetch) deleted every season of the media with its episodes, playback states and markers | an empty list drops nothing |

Frozen as is (decided): the heartbeat keeps its debounce entry after a failed history write and returns
`sessionLost: false` when the engine session lives but presence cannot be rebuilt. Lists whose order comes
from DB collation / ICU (`GET /api/settings`, `/api/fs/browse`, `GET /api/playlists`, the profile `playlists`) are compared order-insensitively by parity;
Rust sorts settings by key and fs entries case-insensitively (lowercase first).

## Open divergences

None.
