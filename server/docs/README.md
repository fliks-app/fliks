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

Decided behaviour for the Rust port (security fixes F, correctness fixes C; D3). Not implemented until the named milestone. Each has a parity exception.

| # | Today (Nest) | Rust behaviour | Client impact |
|---|---|---|---|
| F1 | `POST /api/auth/register` open to anyone | `register` requires `users.manage`, else 403. The `admin/password` seed on an empty users table stays (user decision 2026-10-15) | web client register screen (hide it for non-admins) |
| F2 | `GET /api/users/:id` readable by any user | self or `users.manage`; others 403 | client user pages (social profile uses `/api/social/users/:id/profile`) |
| F3 | `/api/images/*` public | **dropped (user decision 2026-10-15)**: images stay public (id-addressed, low sensitivity; most clients load them without a credential, see `client-audit.md`) | none |
| F4 | `/api/persons/*` public | authenticated | none expected |
| F5 | `GET /api/settings` and `GET /api/engine/remote` return secrets in clear | secret keys redacted with the existing redact/merge convention (`backend/src/common/utils/secret-fields.util.ts`); PUT with the placeholder keeps the stored value | admin settings pages |
| F6 | `refresh_tokens` never pruned | daily prune of expired/revoked rows older than 30 days | none |
| F7 | access token 1 h but cookie `maxAge` default 7 d | cookie `Max-Age` = token lifetime | none |
| F8 | `scope:'stream'` tokens (12 h, travel in URLs) accepted on every route without `SessionTokenGuard`: pairing approve, `PUT /users/:self {password}`, `stream-token` self-renewal, `cast-info` | the extractor rejects `scope:'stream'` (401) except on routes explicitly marked stream-allowed (media delivery routes listed in `auth.md`) | verify every client calls API routes with its access token (parity + client smoke) |
| F9 | password change revokes nothing | revokes every other refresh-token family of the user and drops their SSE connections; the caller keeps its session | none |
| F10 | `users.manage` alone can set `isAdmin`, reset/delete an admin, delete the last admin | only an admin may set `isAdmin` or modify/delete an admin; the last enabled admin cannot be deleted, disabled or demoted (409) | admin user pages show the error |
| F11 | a user can raise their own quota fields | quota fields writable only with `users.manage` | none |
| F12 | `roles.manage` can store any permission string, incl. `manage:all` | permissions validated against `GET /roles/permissions`; granting `manage:all` requires admin | none |
| F13 | `pairing.requested` broadcast to every SSE client | sent only to the target user's connections | none |
| F14 | polled remote targets keyed by `deviceId` only (another account takes them over) | keyed by `(userId, deviceId)` | none |
| F15 | an approved pairing stays claimable after `expiresAt` until the hourly cleanup | claim checks `expiresAt` | none |

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
| C1 | 500 on unvalidated input: `GET /api/remote/commands` without `targetId`, fractional `page`/`limit` on history, non-numeric `startAt` on playback-info, `null` on non-nullable user fields; `toggle-watched` and season `toggle-watched` on an unknown media | 400 with the standard validation body; unknown media → 404 `not_found` |
| C2 | writes before failing: bulk `PUT /api/settings` stops at the first protected key; non-manager `PUT /users/:id` with `libraryIds` saves the rest then 403s | validate and authorise the whole request first, write in one transaction |
| C3 | refresh rotation and pairing claim are not atomic | one transaction with `SELECT … FOR UPDATE` |
| C4 | recommendations ties follow Postgres scan order | score desc, then media id asc |
| C5 | a superseded SSE connection leaves its socket open | the server closes it |
| C6 | playback-info 500s after creating the session when the markers query fails; `toggle-season-watched` does not check the season belongs to the media | markers failure is logged and playback proceeds without markers; season not under the media → 404 |

Frozen as is (decided): the heartbeat keeps its debounce entry after a failed history write and returns
`sessionLost: false` when the engine session lives but presence cannot be rebuilt. Lists whose order comes
from DB collation / ICU (`GET /api/settings`, `/api/fs/browse`) are compared order-insensitively by parity;
Rust sorts by key / name in byte order.

## Open divergences

None.
