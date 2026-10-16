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
| F22 | absolute server paths (`Media.path`, `library.path`, `disk`) were serialised for every reader (`media.read`, library readers) | present only for callers who can manage libraries (`settings.access` or `manage:all`); omitted otherwise on `GET /api/media`, `recently-added`, `GET :id`, `/api/libraries*` and `/api/roles` | client readers use `m.path ?? null` (see `client-audit.md`) |
| F31 | remote state/stopped fan-out reached grantees of a device id under any owner (anyone could mint a code for another user's deviceId and receive its playback state) | fan-out limited to grants whose owner is the device's owner | none |
| F28 | `settings.webhookUrl` of Discord/Slack notification connections returned in clear (the URL embeds its credential) | secret field like `token`: omitted from responses, listed under `secretsSet`; a blank or absent value on write keeps the stored one, `null` is a 400 (the URL is required, so it is replaced, never erased); a type switch drops it | notification editor shows the masked "set" state |
| F29 | gotify token (query string) and webhook URL could reach sender errors, logs and the `test` response | sender errors never contain the request URL | none |
| F30 | Discord payloads allowed `@everyone`/role/user mentions from request titles | Discord body adds `allowed_mentions: {parse: []}` | none |

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
| C1 | 500 on unvalidated input: non-integer or out-of-int4 media filters, `page < 1` with `limit > 0`, negative `recently-added` `limit`, calendar dates Postgres rejects, a `sortBy` naming an `Object.prototype` member (falls back to `title`), `streams` on a library without path (404); library create with a duplicate name, update with a null name, access set with an unknown user; `GET /api/remote/commands` without `targetId`, fractional `page`/`limit` on history, non-numeric `startAt` on playback-info, `null` on non-nullable user fields, `null` `events`/`enabled` and ids beyond int4 on notification connections; `toggle-watched` and season `toggle-watched` on an unknown media | 400 with the standard validation body; unknown media → 404 `not_found` |
| C2 | writes before failing: bulk `PUT /api/settings` stops at the first protected key; non-manager `PUT /users/:id` with `libraryIds` saves the rest then 403s | validate and authorise the whole request first, write in one transaction |
| C3 | refresh rotation and pairing claim are not atomic | one transaction with `SELECT … FOR UPDATE` |
| C4 | recommendations ties follow Postgres scan order | score desc, then media id asc |
| C5 | a superseded SSE connection leaves its socket open | the server closes it |
| C6 | playback-info 500s after creating the session when the markers query fails; `toggle-season-watched` does not check the season belongs to the media | markers failure is logged and playback proceeds without markers; season not under the media → 404 |
| C7 | static client, `/cast` and images: weak ETag from the mtime in ms, `; charset=UTF-8` on text types, `Vary: Origin` only, bare OPTIONS → 204; a missing `/cast/*` file answers 404 with an ENOENT message leaking the absolute path | ETag from mtime in seconds, tower-http `Vary`, bare OPTIONS → 404; missing `/cast/*` → 404 `Cannot GET <url>` (no path leak). Browser-cache only: one re-download per file after the upgrade |
| C8 | raw-SQL / explicit updates did not touch "updatedAt" (series watched toggles, search vector refresh, leave-social playlist privacy, live TV group stamp/renumber) | a BEFORE UPDATE trigger sets "updatedAt" = now() whenever an UPDATE leaves it unchanged (migration `1786500000000_updated_at_trigger.sql`); playlists made private on leave-social move up in the owner's home row |
| C9 | image ids coerced by unary `+` (`007`, `0x7`, `7.0`, ` 7 ` served id 7) | canonical integers only, else 404 |
| C10 | `GET /api/media?q=` ordered by the requested sort (default title) because `orderBy` replaced the relevance order | `q` without `sortBy` orders by FTS rank desc (NULL rank last), then title, then id; the search page now omits `sortBy` unless the user chose one |
| C11 | `cutoffUnmet=true` removed items from the already paginated page (short pages, `total` unchanged) | filtered in SQL before pagination: `page`, `limit` and `total` count only the media that pass |
| C12 | equal sort keys left list order to the database (media list, recently-added, collections, similar, collection, cast, crew, calendar, files, seasons, episodes; libraries, `userIds`) | every list ends with `id ASC` |
| C18 | `POST /api/system/streams/:sid/command` with an `action` outside pause/play/stop/message was relayed to the client as is | 400 |
| C19 | live TV rows of `/api/system/streams` reported the source's name as `quality` (`"Live"` only without one) | they report `"Live"` |
| C20 | ValidationPipe coerced ` 7 `, `1e1`, `0x10` before `ParseIntPipe` | integer path segments must be canonical (`7`, `-7`; never `007`, `+7`, ` 7 `, `0x7`) on every Rust route: `PathParams` / `int_param` → 400 |
| C16 | notification senders had no timeout (axios `timeout: 0`) | 10 s total per request, no retry; `test` reports `timeout of 10000ms exceeded` |
| C17 | a plugin-supplied event outside the notification vocabulary was dispatched (default message) | rejected with 400 before any sender runs |

Frozen as is (decided): the heartbeat keeps its debounce entry after a failed history write and returns
`sessionLost: false` when the engine session lives but presence cannot be rebuilt. Lists whose order comes
from DB collation / ICU (`GET /api/settings`, `/api/fs/browse`) are compared order-insensitively by parity;
Rust sorts settings by key and fs entries case-insensitively (lowercase first).

## Open divergences

None.
