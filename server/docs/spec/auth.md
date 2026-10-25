# Spec: auth

Covers the auth controllers, services, extractors, `casl/*` and `pairing/*`. Env vars (`JWT_SECRET`, `FLIKS_CONF_DIR`, `JWT_EXPIRATION`, `STREAM_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`) are inventoried in `config.md` (Auth table); rules below cite them, not repeat them.

## Routes

13 routes. The extractor `Authed` accepts JWT only: `X-Api-Key` is NOT accepted.

`SafeUser` = JSON object defined in rule 40. `TokenPair` = `{accessToken: string, refreshToken: string, accessTokenExpiresAt: number (unix s), refreshTokenExpiresAt: number (unix s)}`.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `POST /api/auth/login` | none | body `{username: string non-empty, password: string non-empty, serverType?: 'local'\|'jellyfin'\|'emby'\|'plex'}`; unknown keys 400 | 201, `TokenPair` + `user: SafeUser` (one flat object: `{accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, user}`) | 400 validation; 401 `Invalid credentials`; 401 `Account disabled`; 401 `Media server login for <serverType> not yet implemented` | `Set-Cookie fliks_access`; `users.lastLogin`; INSERT `refresh_tokens` |
| `POST /api/auth/refresh` | none | body `{refreshToken: string}` (only that key is read, other keys ignored) | 201, `TokenPair` (no `user`) | 401 `Missing refresh token` / `Invalid refresh token` / `Refresh token already rotated` / `Refresh token reuse detected` / `Refresh token expired` / `Account disabled` | `Set-Cookie fliks_access`; rotate `refresh_tokens` |
| `POST /api/auth/logout` | none (credentials optional) | body `{refreshToken?: string, targetId?: string}` | 204, no body | none (always 204) | clear cookie; revoke refresh token; drop the device's SSE connections |
| `POST /api/auth/register` | `Authed` + `users.manage` | body `{username: string non-empty, password: string non-empty (no min length), email?: string (no email check)}`; unknown keys 400 | 201, `SafeUser` (rule 37) | 409 `Username already taken`; 401 no/invalid credentials, 403 authenticated without `users.manage` | INSERT `users` |
| `GET /api/auth/me` | `Authed` | none | `SafeUser` | 401 | throttled `users.lastLogin` update (rule 42) |
| `GET /api/auth/users-public` | none | none | `[{id: number, username: string, avatar: string\|null}]` enabled users, `ORDER BY username ASC`; `[]` per rule 43 | none | none |
| `POST /api/auth/cast-info` | `Authed` | none | 201, `{token: string, streamBaseUrl: string}` | 401 | none |
| `POST /api/auth/stream-token` | `Authed` | none | 201, `{streamToken: string, expiresAt: number (unix **ms**)}` | 401 | none |
| `POST /api/auth/pairing/request` | none | header `X-Device-Id` required; body `{userId: int, deviceName: string non-empty max 80, systemName?: string max 60}`; unknown keys 400 | 201, `{pairingId: string (uuid), expiresIn: 600}` | 400 `Missing X-Device-Id header`; 404 `User not found`; 400 `Too many pending requests for this device` | INSERT `pairing_requests`; SSE `pairing.requested` (target user only) |
| `GET /api/auth/pairing/status` | none | query `pairingId` (required), header `X-Device-Id` (required) | `{status: 'pending'\|'approved'\|'denied'\|'expired'}` and, once, on the issuing device after approval: `+ TokenPair` | 400 `Missing pairingId`; 400 `Missing X-Device-Id header`; 404 `Pairing request not found` | lazy expire; claim: INSERT `refresh_tokens`, null `accessToken`; `Set-Cookie fliks_access` when tokens ship |
| `GET /api/auth/pairing/pending` | `Authed` | none | `[{pairingId, deviceId, deviceName, systemName: string\|null, requestedAt: ISO, expiresAt: ISO}]` | 401 | none |
| `POST /api/auth/pairing/:pairingId/approve` | `Authed` | path `pairingId` (string, no format check) | 204, no body | 404 `Pairing request not found` (also another user's); 400 `Cannot approve a <status> request`; 400 `Pairing request expired` | `status='approved'` |
| `POST /api/auth/pairing/:pairingId/deny` | `Authed` | path `pairingId` | 204, no body | 404 `Pairing request not found` | `status='denied'` |

No auth route has a policy beyond the extractor.

## Rules

### A. Secret, claims, signing

1. Secret resolution: `JWT_SECRET` env if non-empty (verbatim, no trim); else `<conf>/.jwt-secret` if the file exists (content trimmed); else generate 32 random bytes as 64 hex chars, `mkdir -p <conf>` mode 0700, write the file mode 0600 with an exclusive create, so two starts cannot diverge; if persisting fails, an in-memory fresh hex secret for this process. Cached for the process lifetime.
2. `<conf>` = first writable of `[FLIKS_CONF_DIR.trim || '/app/conf', <os.tmpdir>/fliks-conf]`, probed by creating then unlinking `<dir>/.probe` (dir created recursive, mode 0700); none writable: last candidate with a warning.
3. HMAC key bytes = the secret string's UTF-8 bytes (the 64-char hex is NOT hex-decoded). Header `{"alg":"HS256","typ":"JWT"}`.
4. Access token claims `{sub: number (user id), username: string, iat, exp}`; no `scope` key (absent, not null). `exp - iat` = `JWT_EXPIRATION` (default `'1h'`, parsed by `ms`, see `config.md`).
5. Stream/Cast tokens: same claims plus `scope: 'stream'`. Cast: fixed `expiresIn: '4h'`. Stream: `STREAM_TOKEN_TTL` (default `'12h'`, `ms` grammar). No other claim (no `jti`, no media or session binding).
6. Tokens verify against the same secret file with the same claim names and HS256.

### B. Request authentication (extractor `Authed`)

7. Token source order, first non-empty wins, no fall-through on a bad token: (1) cookie `fliks_access` parsed from the raw `Cookie` header (split on `;`, trimmed, first `fliks_access=` match, percent-decoded with raw fallback; repeated headers are joined with `'; '`); (2) `Authorization: Bearer <t>` (scheme matched case-insensitively, first two whitespace-separated tokens); (3) query `?token=`. An empty value counts as absent. A stale cookie therefore shadows a valid Bearer.
8. Verification: signature with the secret; `exp` enforced with zero leeway; `nbf` honoured if present. Only HS256 is accepted and `exp` is required: a token without `exp` or signed HS384/HS512 is 401. Fliks only signs HS256 with `exp`, so no issued token is affected.
9. After verification: load the user with its role where `id = sub AND enabled = true` on every request (no caching); none found: 401. `username` and every other claim are ignored (a renamed user's token stays valid). A `sub` missing or not an integer is 401. Invalidation is only this lookup: a deleted or disabled user is 401 on the next request and a role change applies on the next request. A password change revokes every refresh-token family of the user and drops their SSE connections; the caller's access token stays valid until `exp` (users.md rule 17). Deleting a user cascades its `refresh_tokens` rows (`onDelete: 'CASCADE'`).
10. Token scope: the payload `scope`, or null when absent. Any non-null value is "scoped" (only `'stream'` is ever issued).
11. `SessionAuthed`: a scoped token gets 403 `{"message":"session_token_required","error":"Forbidden","statusCode":403}`; unscoped passes. It guards the routes that must not take a stream token (declared in their own specs).
12. A `stream`-scope token is refused everywhere it is not explicitly accepted: `Authed` answers 401 (rule 14 body) to any scoped token, `OptionalAuthed` too; only `StreamAuthed` routes (media delivery, each listed in the spec of its domain) accept it, and `SessionAuthed` keeps rule 11's 403. So no auth route takes a stream token (`me`, `stream-token`, `cast-info` included), and a stream token cannot mint new stream tokens, approve pairings or change a password.
13. `OptionalAuthed`: no auth route needs it; unguarded auth routes ignore credentials entirely, except `logout` (rule 50).
14. Every authentication failure (no token, bad signature, expired, unknown or disabled user) returns 401 `{"message":"Unauthorized","statusCode":401}` (no `error` key: the bare form).

### C. Error bodies

15. Error bodies: with a string message `{"message": <string>, "error": <reason phrase>, "statusCode": n}` (`error` = `Unauthorized`, `Forbidden`, `Bad Request`, `Not Found`, `Conflict`, `Payload Too Large`); bare (no message) `{"message": <reason phrase>, "statusCode": n}` with no `error` key. Key order irrelevant. `AppError{status, message: Value, error}` omits `error` for the bare form.
16. Validation failure: 400 `{"message": [<validation messages>], "error": "Bad Request", "statusCode": 400}`; request bodies reject unknown keys and do not coerce JSON types (a boolean field rejects `"true"`, a number field accepts non-integers, an optional field accepts `null` and the value stays `null`). Message text is free-form for the parity runner unless it matches `^[a-z0-9_.]+$`. Unknown body keys: 400 `property <k> should not exist`.
17. Authentication and authorisation run before body validation: an unauthenticated or forbidden request with an invalid body is 401/403, never 400.
18. Integer path params: non-integer string → 400 `Validation failed (numeric string is expected)`. Pairing `:pairingId` is a plain string.

### D. CASL and `Permissions`

19. `User.permissions` getter: `isAdmin` → `['manage:all']`; else the role's `permissions` array; no role → `[]`.
20. If the permission list contains the literal `manage:all` (via `isAdmin` or a role that stores it), the ability is exactly `can(manage, all)` and nothing else is evaluated.
21. Actions (closed enum, string values): `manage create read update delete approve decline grab track`. `manage` as a rule action matches every requested action; a request for `manage` matches only a `manage` rule.
22. Subjects: `User Media FliksRequest QualityProfile LanguageProfile SubtitleProvider SubtitleFile TranslationProvider Library Playlist LiveTvChannel Role` (class names), the strings `Settings` and `all`, and `plugin:<id>:<name>`.
23. Plugin grants: for each permission string `p`: bare `plugin:<rest>` (starts with `plugin:` and is longer than the prefix) → `can(manage, p)`; else split at the **first** `:`, `<action>:<subject>` where `<subject>` is a plugin subject → `can(<action>, <subject>)` if `<action>` is in the enum, otherwise skipped (not widened to `manage`); anything else ignored. Shape only, no check that the plugin exists.
24. Unconditional grants (every non-`manage:all` user): `read` and `update` on `User` with condition `{id: self}`; `read create update delete` on `Playlist`.
25. Core permission table (12 strings, this order). Unknown strings grant nothing.

    | Permission | Grants |
    |---|---|
    | `media.read` | read: Media, QualityProfile, LanguageProfile, SubtitleFile, SubtitleProvider, Library |
    | `media.create` | create Media; plus track Media (shared with `requests.create`) |
    | `media.edit` | update Media |
    | `media.delete` | delete Media |
    | `media.grab` | grab Media |
    | `livetv.read` | read LiveTvChannel |
    | `requests.create` | create FliksRequest; read FliksRequest `{userId: self}`; delete and update FliksRequest `{userId: self, status: 'pending'}`; track Media |
    | `requests.manage` | manage FliksRequest |
    | `subtitles.manage` | create, update, delete SubtitleFile |
    | `settings.access` | read Settings; manage Settings, QualityProfile, LanguageProfile, SubtitleProvider, TranslationProvider, Library |
    | `users.manage` | manage User; read Role |
    | `roles.manage` | manage Role |

26. Class-level vs instance checks: `can(action, Class)` is true when ANY rule exists for that action and subject type, conditions ignored (so every authenticated user passes `can(read, User)` and `can(update, User)` at class level); conditions only bite when an instance is passed. Handlers re-check instances (users.md, roles.md).
27. Policy check: handler policies win over class policies; zero policies declared → deny; no authenticated user → deny; every policy must return true. Denial is 403 `{"message":"Forbidden resource","error":"Forbidden","statusCode":403}`. The explicit "any authenticated user" policy is always true. Every handler's first line requires a permission or that policy.
28. Plugin route policies (`<action>:<Subject>`, split at first `:`, action in enum, subject in the closed core set `User Media FliksRequest QualityProfile LanguageProfile SubtitleProvider SubtitleFile TranslationProvider Library Playlist Settings` or in that plugin's own declared subjects, otherwise deny) are owned by the plugin proxy.

### E. Login, logout, refresh

29. Login lookup: user by exact (case-sensitive) `username` with `passwordHash` selected and role joined. Steps and order: (a) `serverType` defaults `local`; any other value → 401 `Media server login for <serverType> not yet implemented` before any DB access; (b) no user or `passwordHash` null (Emby-imported users) → 401 `Invalid credentials` without running bcrypt; (c) bcrypt mismatch → 401 `Invalid credentials`; (d) `enabled = false` → 401 `Account disabled` (revealed only with the right password); (e) set `lastLogin = now`; (f) issue pair (rule 31); (g) body `user = SafeUser`.
30. bcrypt: cost 12 for every hash (login seed, register, create user, change password); verify accepts the stored hash as is (`$2a$/$2b$/$2y$`), no rehash on login. bcrypt ignores bytes past 72.
31. Token pair issue: access token (rule 4), `accessTokenExpiresAt` = decoded `exp` (fallback `now/1000 + 3600`), refresh token (rule 33), `refreshTokenExpiresAt = floor(expiresAt_ms / 1000)`. Login and pairing claims store `userAgent = null`; refresh stores the request `User-Agent`.
32. The refresh token plaintext is JSON-only (login, refresh, pairing status body), never in a cookie.
33. Refresh token = `randomBytes(48)` base64url (64 chars); stored as `sha256(raw)` lower-case hex (hash input = the token's UTF-8 bytes); `expiresAt = now + REFRESH_TOKEN_TTL_DAYS` days (default 60; `parseInt`, must be finite and > 0 else 60); `userAgent` truncated to 255 chars; `lastUsedAt` null.
34. Rotation (`POST /auth/refresh`), strictly in this order: empty/missing `refreshToken` → 401 `Missing refresh token`; row by hash not found → 401 `Invalid refresh token`; row already `revokedAt`: if `now - revokedAt <= 30 000 ms` → 401 `Refresh token already rotated` (family untouched), else if the token that replaced it (`parentId` = this row) exists and was never used (`lastUsedAt` NULL), the response was lost: 401 `Refresh token already rotated`, nothing revoked; otherwise (successor used, or none) revoke every un-revoked token of that row's family and 401 `Refresh token reuse detected`; `expiresAt < now` → 401 `Refresh token expired` (row not revoked); else set `revokedAt = lastUsedAt = now`. Then user must be `enabled` else 401 `Account disabled` (token already consumed); else issue a new pair (rule 31) and set the cookie. A family is one login or pairing chain: every issue path starts a new `familyId` (the new row's id) and rotation copies the consumed row's family, so other devices of the user keep working. The reuse logs a warning with the user, token, family and both user agents.
35. Rotation is atomic: one transaction over `SELECT … FOR UPDATE` on the token row (insert of the new token included); a concurrent duplicate lands in the 30 s grace branch.
36. Logout revokes the presented refresh token by the same `revokedAt` column as rotation, so presenting a logged-out refresh token more than 30 s later triggers the family revoke of rule 34 (every live token of that login chain), and within 30 s it is 401 `Refresh token already rotated`.
37. Register: username taken (exact match) → 409 `Username already taken`; role = the role with `isDefault = true`; user row: `passwordHash = bcrypt12`, `isAdmin = false`, `mediaServerType = 'local'`, `roleId`. Response is the `SafeUser` of the saved user, whose role is not loaded: `role` is `null` and `permissions` is `[]`.
38. `POST /api/auth/register` requires authentication and `users.manage` (`manage:all` qualifies); otherwise 403. Anonymous or invalid credentials get 401 from the extractor (auth runs before the handler). The table is never empty for an authorised caller, so register has no first-user branch and no role-seeding fallback. The `admin`/`password` seed on an empty `users` table is the only first user (users.md rule 7). The client hides the register screen for non-admins.
39. No login rate limiting or lockout (recorded so reviewers do not add it).

### F. Response shapes

40. `SafeUser` (login `user`, `GET /auth/me`, register): every `users` column except `passwordHash`, plus `role`, `permissions`, `libraryIds`, `features`. Column keys: `id, createdAt, updatedAt, username, email, roleId, mediaServerType, mediaServerId, avatar, lastLogin, isAdmin, enabled, requirePasswordChange, movieQuotaLimit, seriesQuotaLimit, quotaPeriodDays, libraryOrder, hiddenLibraryIds, profileVisibility, shareTastes, shareRecommendations, shareWatchHistory, shareLikes, shareStats, shareDisabled, hideSpoilers, edlEnabled, edlAutoSkipCommercials, spoilerHideStills, spoilerHideOverviews, spoilerHideTitles` (types: users.md rule 2). Computed: `role` = role name, else `'Admin'` if `isAdmin`, else `null` (differs from the users module, which gives `null`); `permissions` = rule 19; `libraryIds` always `[]` here (never hydrated); `features` = rule 41. Dates are ISO-8601 with ms (`...000Z`). `passwordHash` never serialised (`select: false` and `@Exclude`); the object is a plain object so class-transformer does nothing.
41. `features`: `['deviceProfileExtensions','hlsSubtitleRequest','muxedAudioRendition']` filtered by the engine's `hello.features`: `deviceProfileExtensions` needs `decide`, the other two need `serve`; no engine hello yet → `[]`. Order preserved.
42. `GET /auth/me` side effect: if `lastLogin` is null or older than 60 000 ms, `UPDATE users SET "lastLogin" = now, "updatedAt" = now WHERE id`; the response carries the value loaded before the update (stale). Runs for scoped tokens too.
43. `users-public`: enabled users only, fields exactly `id, username, avatar` (`avatar` null when unset), `ORDER BY username ASC` (database collation). No auth. Setting `users_public_mode` (`everyone` default and any unknown value, `lan`, `hidden`; `settings.md` validates it on write): `hidden` answers `[]`; `lan` answers the roster only when the socket peer and every `X-Forwarded-For` entry are private, loopback or link-local addresses (IPv6: loopback, unique-local, link-local), else `[]`. A reverse proxy that does not set `X-Forwarded-For` makes every client look local.
44. `cast-info`: `token` = Cast token (rule 5); `streamBaseUrl` = setting `public_url` with trailing `/`s stripped when non-empty; else `<proto>://<Host>` where `proto` is the raw `X-Forwarded-Proto` header (not split on `,`) or `http`, and `Host` the request `Host` header; else `http://localhost:<PORT||4848>`.
45. `stream-token`: `streamToken` = rule 5; `expiresAt = now + ttlMs` in **milliseconds**, where `ttlMs` is the TTL of the token actually signed, from the one `ms` parser (rule 48; `config.md`).

### G. Cookies

46. Name `fliks_access`, value = the access JWT (`encodeURIComponent`), set on login, refresh and on the pairing `status` response that carries tokens.
47. Attributes: `HttpOnly`; `Path=/`; `Secure` iff the request is secure (TLS, or `X-Forwarded-Proto` first comma-separated value equals `https`, case-insensitive); `SameSite=None` iff `Origin` is exactly one of `https://localhost`, `capacitor://localhost`, `http://localhost` AND secure, else `SameSite=Lax`; `Max-Age = floor(maxAgeMs/1000)` and `Expires = now + maxAgeMs`. No `Domain`.
48. One parser for `JWT_EXPIRATION` and `STREAM_TOKEN_TTL`, the `ms` grammar (a bare number is milliseconds, `3600` = 3 s; an unparsable value or one under 1 s falls back to the default with a warning); cookie `Max-Age` equals `exp - iat` (default 3600). Applies to login, refresh and pairing status.
49. Logout clears the cookie: `Set-Cookie fliks_access=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure iff secure; SameSite per rule 47` (no `Max-Age`). Sent even when no credentials were presented.
50. Logout ordering: clear cookie; if `refreshToken` given revoke it (`UPDATE... SET revokedAt WHERE tokenHash AND revokedAt IS NULL`), errors swallowed; token for the SSE drop = cookie value, else `Authorization` starting with exactly `Bearer ` (no `?token=`); verify it (signature and `exp`, no user lookup); if valid and `targetId` present: drop that user's SSE and polled connections whose target id equals `targetId` ; valid but no `targetId`: only a warning, nothing dropped (other devices untouched); invalid/expired token: silent. An empty `fliks_access=` cookie still counts as the token source, so it suppresses the Bearer fallback and nothing is dropped. Always 204.

### H. Pairing state machine

51. Constants: TTL 10 min (`expiresIn: 600` in the response), at most 3 `pending` rows per `deviceId`.
52. States `pending → approved | denied | expired`. `approved` additionally has a one-shot claim: row `accessToken` holds the sentinel `'__approved__'` from approval until the issuing device polls, then `NULL` (status stays `approved`).
53. `request` (anonymous): header `X-Device-Id` empty/missing → 400 `Missing X-Device-Id header` (checked after body validation, rule 17); user `userId` must exist AND be enabled else 404 `User not found`; `COUNT(*) WHERE deviceId = ? AND status = 'pending'` (includes rows already past `expiresAt` that no one flipped yet) `>= 3` → 400 `Too many pending requests for this device`; insert `publicId = uuid v4`, `deviceName` (cut to 80), `systemName` (cut to 60, else null), `status 'pending'`, `accessToken null`, `expiresAt = now + 10 min`; emit `pairing.requested` to the target user only (Events); return `{pairingId: publicId, expiresIn: 600}`, 201. Any anonymous caller can open a request for any enabled user id (ids come from `users-public`).
54. `status`: missing `pairingId` → 400 `Missing pairingId`; missing header → 400 `Missing X-Device-Id header`; unknown `publicId` → 404 `Pairing request not found`; a `pending` row past `expiresAt` is flipped to `expired` (persisted) and returned as such; claim condition = `status = 'approved' AND row.deviceId = header AND accessToken = '__approved__' AND approvedByUserId is set`: then load the approver user (by id, **no `enabled` check**; not found → `{status:'approved'}` without tokens), issue a pair (rule 31, `userAgent` null), set row `accessToken = NULL`, return `{status,...TokenPair}` and set the cookie. Every other case returns `{status}` only (wrong device, already claimed, pending, denied, expired) with no error. The claim checks `expiresAt`: an unclaimed approved row past it is flipped to `expired` (sentinel cleared) and answers `{"status":"expired"}`. The claim runs under `SELECT … FOR UPDATE` in one transaction, so one of two simultaneous polls gets tokens.
55. Note: the account whose id is stored is `approvedByUserId` (always the request's `userId`, because approve requires ownership).
56. `pending` list: rows where `userId = caller AND status = 'pending'` `ORDER BY createdAt DESC`, then drop rows with `expiresAt < now` in memory; fields `pairingId` (= `publicId`), `deviceId`, `deviceName`, `systemName`, `requestedAt` (= `createdAt`), `expiresAt`.
57. `approve`: row by `publicId` that belongs to the caller else 404 `Pairing request not found` (same answer for a foreign row); `status != 'pending'` → 400 `Cannot approve a <status> request`; `expiresAt < now` → persist `expired`, 400 `Pairing request expired`; else `status='approved'`, `approvedByUserId = caller`, `accessToken = '__approved__'`; 204.
58. `deny`: ownership as above (404); if `status != 'pending'` no-op; else `status='denied'`, `approvedByUserId = caller`; 204 (expiry is not checked).
59. Validation: `userId` integer; `deviceName` string, non-empty, max 80; `systemName` optional string max 60.

### I. Jobs and token hygiene

60. Pairing cleanup cron hourly: `DELETE FROM pairing_requests WHERE "expiresAt" < now - 10 min` (rows are removed 10 min after they expired, not at expiry).
61. A daily job deletes `refresh_tokens` rows expired for more than 30 days or revoked for more than 30 days (SQL below).
62. A token replayed after its revoked row was pruned yields `Invalid refresh token` instead of the family revoke; rows younger than 30 days (far past the 30 s grace) keep detection intact.

## SQL

Tables `users`, `roles`, `refresh_tokens`, `pairing_requests` (base columns `id, "createdAt", "updatedAt"`). `roles.permissions` is `simple-json` (a text column holding a JSON array). Table DDL is in the sqlx migrations.

- Extractor, per request: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.id = $1 AND u.enabled = true LIMIT 1`; `u."passwordHash"` is never selected here.
- Login: `SELECT u.*, u."passwordHash", r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.username = $1`.
- Login activity: `UPDATE users SET "lastLogin" = $1, "updatedAt" = now WHERE id = $2`. `GET /me`: same statement, gated by rule 42.
- Users public: `SELECT id, username, avatar FROM users WHERE enabled = true ORDER BY username ASC`.
- Register: `SELECT... FROM users WHERE username = $1`; `SELECT... FROM roles WHERE "isDefault" = true`; `INSERT INTO users (username, email, "passwordHash", "roleId", "isAdmin", "mediaServerType") VALUES (...) RETURNING id`.
- Refresh tokens: issue `INSERT INTO refresh_tokens ("userId","tokenHash","expiresAt","userAgent","lastUsedAt","familyId","parentId") VALUES ($1,$2,$3,$4,NULL,$5,$6)` ($5,$6 = the consumed row's family and id on rotation, else the new row's own id and NULL); rotate lookup `SELECT rt.*, u.*, r.* FROM refresh_tokens rt JOIN users u ON u.id = rt."userId" LEFT JOIN roles r ON r.id = u."roleId" WHERE rt."tokenHash" = $1`; mark used `UPDATE refresh_tokens SET "revokedAt" = $1, "lastUsedAt" = $1, "updatedAt" = now WHERE id = $2`; revoke one `UPDATE refresh_tokens SET "revokedAt" = now WHERE "tokenHash" = $1 AND "revokedAt" IS NULL`; revoke family `UPDATE refresh_tokens SET "revokedAt" = now WHERE "familyId" = $1 AND "revokedAt" IS NULL`.
- Refresh-token prune: `DELETE FROM refresh_tokens WHERE "expiresAt" < now - interval '30 days' OR ("revokedAt" IS NOT NULL AND "revokedAt" < now - interval '30 days')`.
- Pairing: user check `SELECT... FROM users WHERE id = $1 AND enabled = true`; pending count `SELECT count(*) FROM pairing_requests WHERE "deviceId" = $1 AND status = 'pending'`; insert; by id `SELECT... FROM pairing_requests WHERE "publicId" = $1`; lazy expire / approve / deny / claim are `UPDATE pairing_requests SET status|"approvedByUserId"|"accessToken", "updatedAt" = now WHERE id = $n`; pending list `SELECT... WHERE "userId" = $1 AND status = 'pending' ORDER BY "createdAt" DESC`; cleanup `DELETE FROM pairing_requests WHERE "expiresAt" < $1` with `$1 = now - 10 min`.
- Settings read for cast-info: `SELECT value FROM settings WHERE key = 'public_url'` (settings table/shape owned by the settings spec).

## Events

| Event | Audience | Payload | Emitter / consumer |
|---|---|---|---|
| SSE `pairing.requested` | only the connections of `userId` | `{type: 'pairing.requested', userId: number, pairingId: string, deviceName: string, deviceId: string}` | emitted by the pairing request handler after the insert; consumed by the client pending-requests page |

## Settings keys

| Key | Use |
|---|---|
| `public_url` | read by `cast-info` (rule 44); empty/unset falls back to the `Host` header. Owned by the settings spec. |

Env vars: see `config.md` (Auth table). No other settings keys.

## Jobs/timers

| Job | Schedule | Behaviour |
|---|---|---|
| pairing cleanup | hourly | rule 60 |
| refresh-token prune | daily at 03:30 server local time | rule 61 |

## Vectors/parity

Fixture set `acl`: `server/fixtures/acl/cases.json`, 35 cases, each `input {label, userId, isAdmin, rolePermissions[], instances[]}` and `expected.checks[{action, subject, allowed}]` over 9 actions x core subjects, `plugin:<id>:<name>` subjects and instance subjects (`User.self`, `User.other`, `FliksRequest.ownPending`, `FliksRequest.ownApproved`, `FliksRequest.otherPending`,...), replayed by the Rust `acl` test. Covers rules 19-26.

Rust unit tests: cookie attribute matrix (rule 47: secure x origin, `X-Forwarded-Proto` list), `ms` duration parse, refresh state machine with an injected clock (rule 34, incl. the 30 s boundary `<=` and replay after the grace), JWT verify matrix (cookie shadows Bearer, empty cookie, `?token=`, expired, HS384 rejected, `scope`, disabled user), pairing state machine incl. the 3-pending cap with expired-but-unflipped rows.

Parity scenarios: 60 files in `server/parity/scenarios/auth/`. Cookie assertions use `expect.headers` for `Set-Cookie` (`ignore` timestamps and tokens). The 30 s grace and replay-after-grace cannot be aged by the runner (no SQL step): the Rust unit tests above cover them.

## Open questions

None.
