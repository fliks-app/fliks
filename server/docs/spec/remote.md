# Spec: remote control (+ grants)

Hub-side target state is owned by `events-hub.md` and referenced by name only.

Scope of the domain: which devices ("targets") an account may see and command, the per-device grant codes, the household fan-out of `remote.*` events. The live connection map, polled-target queues, attribution claims, superseded-connection eviction and the SSE transport are hub state: see `events-hub.md` (D-hub below).

## Routes

Every route requires a session credential: a `scope:'stream'`/`'cast'` token is rejected on every route with `403 { message: "session_token_required" }`. No CASL policy applies (the real gate is `canControl`). An unknown body property is 400. Auth failures: 401 (no/invalid credential).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/remote/targets` | session-only credential; no policy | query `self?: string` | `RemoteTargetDto[]` | 401, 403 `session_token_required` | none; lazily evicts expired polled targets and emits `remote.targets_changed` (rule 18) |
| `POST /api/remote/register` | session-only credential; no policy | body `RemoteRegisterDto` | 201, `{ targetId: string }` | 400 validation, 401, 403 | registers a polled target in the hub; first registration emits `remote.targets_changed` to the owner (rules 17-18) |
| `GET /api/remote/commands` | session-only credential; no policy | query `targetId: string` (required) | `unknown[]` (queued `remote.command` events, possibly `[]`) | 404 `remote.error_device_offline`, 403 `remote.error_<reason>`, 400 `targetId must be a string` when missing (rule 22) | drains and clears the polled queue, refreshes `lastPoll` (rule 19) |
| `POST /api/remote/grants/code` | session-only credential; no policy | body `CreateGrantCodeDto` | 201, `{ id: number, code: string, expiresIn: number }` | 400 `remote.error_too_many_codes`, 400 `remote.error_code_unavailable`, 400 validation | deletes expired unclaimed codes; INSERT `remote_control_grants`; no `remote.targets_changed` (rule 24) |
| `POST /api/remote/grants/claim` | session-only credential; no policy | body `ClaimGrantDto` | 201, `GrantDto` | 404 `remote.error_unknown_code`, 404 `remote.error_expired_code`, 400 `remote.error_own_device`, 400 validation | sets `granteeUserId`, clears `code`; announces `remote.targets_changed` to grantee and owner; deletes an expired or duplicate row (rule 25) |
| `GET /api/remote/grants` | session-only credential; no policy | query `deviceId?: string` | `{ issued: GrantDto[], held: GrantDto[] }` | 401, 403 | none |
| `DELETE /api/remote/grants/:id` | session-only credential; no policy | `:id` canonical integer | 204, no body | 404 `remote.error_unknown_grant`, 400 `Validation failed (numeric string is expected)` for a non-integer id | DELETE `remote_control_grants` row; announces `remote.targets_changed` to grantee (if any) and owner (rule 28) |
| `POST /api/remote/:targetId/command` | session-only credential; no policy | body `RemoteCommandDto` | 202, `{ cmdId: string }` (uuid v4) | 404 `remote.error_device_offline`, 403 `remote.error_<reason>`, 400 `remote.error_self_target`, 400 `remote.error_unknown_action`, 400 validation | `remote.command` event to the resolved connection only; `claimAttribution` when `action` is `load` with `mediaFileId` (rules 13, 16) |

Error messages are translation keys unless noted.

The literal routes `register`, `commands`, `targets`, `grants/*` are distinct from the 2-segment `:targetId/command`.

DTOs (400 bodies are the standard validation body `{ statusCode: 400, message: string[], error: "Bad Request" }`; messages are free text):
- `RemoteRegisterDto { deviceId: string (max 128), name?: string (max 128), formFactor?: string (max 32) }`.
- `CreateGrantCodeDto { deviceId: string (max 128), deviceName: string (max 80) }`; `ClaimGrantDto { code: string (length 4..12) }`.
- `RemoteCommandDto`: `action` in `load|play|pause|playpause|stop|seek|volume|mute|next|audio|subtitle|quality|browse` (required); optional `mediaId: int`, `mediaType: 'movie'|'series'`, `mediaFileId: int`, `episodeId: int`, `positionSeconds: number >= 0`, `level: number 0..1`, `muted: boolean`, `trackId: string`, `subtitleId: string | null` (null allowed, the only nullable field), `qualityId: string`, `paused: boolean` (with `load`: open paused instead of playing), `byTargetId: string`.
- `RemoteTargetDto { targetId: string, userAgent: string|null, deviceName: string|null, systemName: string|null, formFactor: string|null, tvPlatform: string|null, ownerUsername: string|null, nowPlaying: RemoteNowPlayingDto|null }`; `RemoteNowPlayingDto { mediaFileId: number, mediaTitle: string|null, mediaType: string|null, posterUrl: string|null, positionSeconds: number, state: 'playing'|'paused'|'buffering' }`. All keys always present (null, not absent).
- `GrantDto { id: number, deviceId: string, deviceName: string, ownerUsername: string|null, granteeUsername: string|null, createdAt: ISO-8601 string }`. Grant rows are only serialized through `GrantDto`.

## Rules

Targets and listing
1. A target id is `deviceId#tabNonce` (SSE client) or `deviceId#native` (polled client); `deviceIdOf(targetId)` = text before the first `#` (whole string when none). Grants are keyed by device id, so every tab/reconnect of a device shares one permission. A `deviceId` that itself contains `#` collapses to its prefix (consequence of the same function).
2. `GET /targets` rows, in this order: (a) the caller's own live targets from the hub (`listForUser`), skipping the one whose `targetId === self` (UX filter, not security); (b) then, for an admin, every other account's targets (`listAll` minus caller's own, minus `self`) with `ownerUsername` set from `users`, and the result is returned at once; (c) for a non-admin, the targets of accounts that granted a device to the caller, kept only when `deviceIdOf(targetId)` is in the caller's granted device set (a second device of the same owner stays invisible), each with `ownerUsername` = owner's username. Own rows have `ownerUsername: null`.
3. Within one source, rows are ordered by connection `since` descending (hub `collect` sorts SSE and polled entries together). Across owners in (c) the order follows the unordered `users` query (DB order): clients do not rely on it, parity must sort or ignore order.
4. (c) only lists owners with `enabled = true`; (b) admin listing does not filter disabled owners (it lists whatever the hub holds).
5. `nowPlaying`: the live session (presence registry, see `presence.md`) whose `sseConnectionId === connection.connectionId`; omitted (null) when none, or when `lastBeat` is older than `liveSessionTtlMs` (30 000 ms default, env `STREAM_LIVE_SESSION_TTL_MS`, positive int else default). `systemName` comes from the same live session (`null` when none, even if stale); `positionSeconds` = session `position`, `state` = session `state`. A polled target's connection id is `polled:<targetId>`; its heartbeat carries `targetId` and the server stores `sseConnectionId = polled:<targetId>` on the session, so it matches too.
6. `userAgent`, `deviceName`, `formFactor`, `tvPlatform` come from the connection identity captured at SSE connect (`/api/system/events` query `device, ff, tvPlatform, name`) or at `register` (`formFactor` default `'tv'`, `tvPlatform` null, `userAgent` null, `deviceName` = `name ?? null`).

Authorization (`canControl`)
7. `canControl(me, targetUserId, deviceId)` returns `{ allowed, reason }`, evaluated in this order: `targetUserId == null` -> admin ? `admin`: deny `ownerless_target_requires_admin`; `targetUserId === me.id` -> allow `self`; admin -> allow `admin`; target user row missing -> deny `target_user_missing`; empty/absent `deviceId` -> deny `no_device_id`; no grant row `(deviceId, granteeUserId = me.id)` -> deny `device_not_granted`; target user `enabled = false` (re-read) -> deny `target_disabled`; else allow `granted`. The `ownerless` branch is unreachable (owners always resolve to a user id) but is kept in the predicate.
8. "Admin" = `can(Manage, 'Settings')` on the user's ability: `users.isAdmin` or role permission `settings.access` or `manage:all`.
9. The same predicate runs at listing visibility and at `command`/`commands` (`authorizeTarget`): `findTargetOwner` resolves visibility, then `canControl` consents.
10. `findTargetOwner(me, targetId)` order: (i) own connection via hub `resolveTarget(me.id, targetId)` (newest wins when several map, warning logged) -> owner = me; (ii) for each device grant of the caller (`grantedDevices`) whose `deviceId === deviceIdOf(targetId)`: hub `resolveTarget(grant.ownerUserId, targetId)`; first hit wins, owner username looked up; (iii) admin only: scan `listAll()` for `connection.targetId === targetId`, first hit; else null.
11. `authorizeTarget`: not found -> `404 remote.error_device_offline`; `canControl` denied -> `403 remote.error_<reason>` (e.g. `remote.error_device_not_granted`); both logged at warn. 404 never reveals whether a target exists outside the caller's scope.

Commands
12. `POST /:targetId/command` order: authorize (404/403) -> self-target check -> action check -> deliver. `targetId === dto.byTargetId` -> `400 remote.error_self_target`. The `remote.error_unknown_action` branch is unreachable (the body validation rejects first with a validation 400).
13. Delivery: `emitToConnection(connectionId, event)` of exactly the resolved connection, never `emitToUser` (a fallback broadcast would let one phone pause every device of the account). The event is `{...dto, type: 'remote.command', cmdId: <uuid v4>, expiresAt: <epoch ms, 10 s ahead>, byTargetId: dto.byTargetId ?? null }`: every validated DTO field is forwarded (including `qualityId` and `paused`), absent optional fields are omitted from the JSON, `subtitleId: null` is kept.
14. Delivery returns false (dead SSE socket, or polled queue already at 20) -> `404 remote.error_device_offline`; success is never reported for a dropped command. Response `202 { cmdId }`.
15. `expiresAt` is an absolute epoch-ms deadline (10 s TTL): the target drops a late command itself; the server does not expire queued/pushed commands.
16. Attribution: when `action === 'load'` and `mediaFileId` is truthy, `claimAttribution(targetId, me.id, mediaFileId)` (hub state, 60 s TTL, consumed by the next playback-info on that target for the same file) after a successful delivery; no claim for any other action, nor `browse`.

Polled targets
17. `POST /register` derives `targetId = deviceId + '#native'` server-side (a caller-supplied id is never accepted) and calls the hub `registerPolledTarget(me.id, { targetId, formFactor: body.formFactor ?? 'tv', tvPlatform: null, deviceName: body.name ?? null, userAgent: null })`; response `{ targetId }`, status 201.
18. Hub semantics (D-hub): polled map keyed `polled:<targetId>` (also its connection id); re-register keeps `since` and the queue and refreshes `lastPoll`; first registration emits `remote.targets_changed` to the owner; entry expires `POLLED_TARGET_TTL_MS = 30000` after the last poll, evicted lazily during any listing/resolve (emitting `remote.targets_changed`); queue bounded `POLLED_QUEUE_MAX = 20`.
19. `GET /commands?targetId=`: `authorizeTarget` first (so a grantee passes visibility/consent), then hub `drainCommands(me.id, targetId)`: returns and clears the queue, refreshes `lastPoll`; `null` (no polled target of the caller with that id: an unknown target, an SSE target or someone else's) -> `404 remote.error_device_offline`. Draining is at-most-once per command.
20. An expired polled target reads as offline (404): the client must re-`register`. The 404 (not `[]`) is deliberate: a mis-registered device must not poll forever in silence.
21. A polled target is keyed by the owner and `polled:<targetId>`: a second account registering the same `deviceId` gets its own entry, so it cannot take the device over or drain its queued commands.
22. `GET /commands` without `targetId` is `400 { statusCode: 400, message: ["targetId must be a string"], error: "Bad Request" }`.

Grants
23. Constants: code TTL 600 000 ms (response `expiresIn: 600`, seconds, `floor`), max 3 unclaimed codes per `deviceId`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0, 1), length 6, mint retries 10.
24. `POST /grants/code`: (1) delete every unclaimed code (grantee null) with `codeExpiresAt` in the past, for all devices; (2) count unclaimed rows of this `deviceId` (any owner): `>= 3` -> `400 remote.error_too_many_codes`; (3) mint: draw 6 chars from a CSPRNG, accept when no row has that code, up to 10 draws else `400 remote.error_code_unavailable`; (4) insert `{ code, deviceId, ownerUserId = caller, granteeUserId = null, deviceName.slice(0,80), codeExpiresAt = 10 min ahead }`; response `{ id, code, expiresIn: 600 }` status 201. No `remote.targets_changed` is emitted.
25. `POST /grants/claim`: `code` = `trim().toUpperCase()` of the body value (the length check 4..12 runs on the raw value first). Row lookup `code = $1 AND granteeUserId IS NULL`. Order of failures: no row -> `404 remote.error_unknown_code`; `codeExpiresAt` in the past -> delete the row, `404 remote.error_expired_code`; `ownerUserId === caller` -> `400 remote.error_own_device` (row kept); caller already holds a grant on that device (any owner) -> delete the new row, return the EXISTING grant as `GrantDto` (no announce, status 201); else set `code = null`, `granteeUserId = caller`, save, announce `remote.targets_changed` to grantee and owner, return `GrantDto`.
26. A code is single-use: cleared (NULL) on claim so a displayed string never reaches an established grant. Only the code expires; a claimed grant stands until revoked. There is no account-level or follow-based gating.
27. `GET /grants`: `held` = rows where `granteeUserId = caller`; `issued` = rows where `ownerUserId = caller AND granteeUserId IS NOT NULL` (+ `AND deviceId = $q` when `deviceId` query is truthy). Unclaimed codes never appear. No ORDER BY (DB order). `ownerUsername`/`granteeUsername` resolved via `users` (null when the user is gone).
28. `DELETE /grants/:id`: unknown id -> `404 remote.error_unknown_grant`; caller neither owner nor grantee -> the same 404 (existence not revealed); else delete (also works on an unclaimed code row by its owner, which is how a device withdraws a code), announce `remote.targets_changed` to grantee (if any) and owner; 204.
29. `announce(...ids)`: `emitToUser(id, { type: 'remote.targets_changed' })` for each distinct non-null id. Because it uses `emitToUser`, the household fan-out of rule 31 also applies to it.
30. No cleanup of grants on user delete, user disable or device sign-out: no FK, no cascade in the schema; `canControl` re-reads `enabled`, and a deleted owner makes `target_user_missing` / dangling rows.

Household fan-out
31. `emitToUser` calls the registered fan-out hook (registered once by the remote service) after dispatching to the owner, only for `remote.state`, `remote.targets_changed`, `remote.stopped`. `emitToUsers` never triggers it, which prevents loops.
32. `fanOutToGrantees(ownerId, event)`: cache key `device:<ownerId>:<deviceIdOf(event.targetId)>` for `remote.state`/`remote.stopped` (frames scoped to the one device), else `owner:<ownerId>` for `remote.targets_changed`; viewers = `granteesForDevice(ownerId, deviceId)` (grant rows of that device whose `ownerUserId` is the event's owner, grantee non-null, so a code minted by anyone else for that device id never receives its playback state) or `granteesForOwner(ownerId)`; audience = viewers + all enabled admins, de-duplicated, minus the owner; if non-empty `emitToUsers(audience, event)`.
33. Two in-memory caches of 30 000 ms (`GRANT_CACHE_MS`): `viewerCache: Map<key, { ids, at }>` and `adminCache: { ids, at }`. They are never invalidated on grant/revoke/claim: a new/revoked grant affects the audience of state frames up to 30 s late, while the command path re-checks the DB on every command. The viewer map has no eviction (one key per device/owner seen).
34. `adminIds()` = all `enabled = true` users filtered by rule 8, cached 30 s.

## SQL

Equivalent SQL. Admin checks join `users` with `roles`.

| Purpose | Equivalent SQL |
|---|---|
| enabled users for admin audience | `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.enabled = true` (admin if `u."isAdmin"` or `r.permissions` JSON contains `settings.access`/`manage:all`) |
| owners of other accounts' targets (admin list) | `... FROM users u LEFT JOIN roles r... WHERE u.id IN ($1,...)` |
| owners of granted devices (non-admin list) | `... WHERE u.id IN ($1,...) AND u.enabled = true` (no ORDER BY) |
| target user (canControl) | `... WHERE u.id = $1 LIMIT 1` |
| owner username (findTargetOwner) | `... WHERE u.id = $1 LIMIT 1` |
| usernames for DTOs | `SELECT... FROM users WHERE id IN ($1,...)` (`findByIds`) |
| is granted | `SELECT count(*) FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" = $2` (>0) |
| granted devices | `SELECT * FROM remote_control_grants WHERE "granteeUserId" = $1` |
| grantees of a device | `SELECT * FROM remote_control_grants WHERE "deviceId" = $1` then keep non-null `granteeUserId`, restricted to `AND "ownerUserId" = $owner` |
| grantees of an owner | `SELECT * FROM remote_control_grants WHERE "ownerUserId" = $1` then keep non-null `granteeUserId` |
| held / issued lists | `... WHERE "granteeUserId" = $1` / `... WHERE "ownerUserId" = $1 AND "granteeUserId" IS NOT NULL [AND "deviceId" = $2]` |
| prune expired codes | `DELETE FROM remote_control_grants WHERE "granteeUserId" IS NULL AND "codeExpiresAt" < $now` |
| unclaimed per device | `SELECT count(*) FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" IS NULL` |
| code clash | `SELECT count(*) FROM remote_control_grants WHERE code = $1` |
| insert code | `INSERT INTO remote_control_grants (code, "deviceId", "ownerUserId", "granteeUserId", "deviceName", "codeExpiresAt") VALUES ($1,$2,$3,NULL,$4,$5) RETURNING id, "createdAt", "updatedAt"` |
| claim lookup | `SELECT * FROM remote_control_grants WHERE code = $1 AND "granteeUserId" IS NULL LIMIT 1` |
| existing grant | `SELECT * FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" = $2 LIMIT 1` |
| claim save / delete | `UPDATE remote_control_grants SET code = NULL, "granteeUserId" = $1, "updatedAt" = now() WHERE id = $2` / `DELETE FROM remote_control_grants WHERE id = $1` |
| revoke lookup | `SELECT * FROM remote_control_grants WHERE id = $1 LIMIT 1` |

Schema:
`CREATE TABLE IF NOT EXISTS "remote_control_grants" ("id" SERIAL PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "code" character varying(12), "deviceId" character varying NOT NULL, "ownerUserId" integer NOT NULL, "granteeUserId" integer, "deviceName" character varying NOT NULL, "codeExpiresAt" timestamptz NOT NULL)`; indexes `IDX_735e31a7f8cf53db91cc04339d` (code), `IDX_34d4b3c63c41ebc088ba3cfcdb` (deviceId), `IDX_a5a52f3d116c44c2944f0b1088` (ownerUserId), `IDX_28efb3a0402a49dca862fb62e6` (granteeUserId); no unique constraint on `(deviceId, granteeUserId)` and no foreign keys (concurrent claims of two codes for the same device by one user can create duplicates; `isGranted` counts > 0 so behavior is unaffected).

## Events

SSE frames are `data: <JSON of the event>\n\n` with the `type` inside the JSON (no named SSE event), delivered by the hub per audience (see `events-hub.md`).

| Event | Audience | Payload | Emitter | Consumer |
|---|---|---|---|---|
| `remote.command` | exactly one connection (`emitToConnection`); a polled target gets it in its queue instead | `{ type, cmdId: string, expiresAt: number (epoch ms), byTargetId: string\|null, action, mediaId?, mediaType?, mediaFileId?, episodeId?, positionSeconds?, level?, muted?, trackId?, subtitleId?: string\|null, qualityId?, paused? }` | `POST /api/remote/:targetId/command` | the target client |
| `remote.state` | the emitting user's connections + household fan-out (grantees of that device + admins, minus owner) | `{ type, targetId: string }` + `RemoteStatePayload { sessionId, mediaId: number\|null, mediaFileId, episodeId?: number\|null, mediaTitle: string\|null, episodeLabel: string\|null, posterUrl: string\|null, fanartUrl: string\|null, positionSeconds, durationSeconds, state: 'playing'\|'paused'\|'buffering', volume: number\|null, muted: boolean\|null, supportsVolume: boolean, subtitleId: string\|null, quality: string\|null, qualities: {id,label,lowBandwidth?}[]\|null, autoplayBlocked: boolean, hasNext: boolean, audioTrackIndex: number\|null, subtitleTrackIndex: number\|null, lastCmdId: string\|null }` | playback heartbeat, every heartbeat (about 10 s per playing session); skipped (debug log) when the stored connection has no target id | controllers' UIs |
| `remote.stopped` | same as `remote.state` | `{ type, targetId: string }` | `DELETE /api/stream/sessions/:sid` when the session's connection resolves to a target | controllers |
| `remote.targets_changed` | the owner's connections + household fan-out by `owner:<id>` key | `{ type }` (no data: "refetch the target list") | grant `announce` (claim, revoke); hub on SSE connect/disconnect with a target id, polled register/expiry/drop, `dropConnectionsForUser`/`ForTarget` | controllers |

Domain events: none. Dependency on the hub (D-hub): this domain uses `listForUser`, `listAll`, `resolveTarget`, `emitToConnection`, `emitToUser` (+ fan-out hook), `emitToUsers`, `registerPolledTarget`, `drainCommands`, `claimAttribution`/`takeAttribution`, `targetIdFor(connectionId)`, `dropConnectionsForUser/ForTarget` from the hub component and does not duplicate connection state; `GET /api/remote/*` and the hub live in the same process.

## Settings keys

none. Env: `STREAM_LIVE_SESSION_TTL_MS` (via presence TTL, rule 5).

## Jobs/timers

No cron. Time constants: command TTL 10 s, grant viewer/admin cache 30 s, grant code TTL 10 min, polled target TTL 30 s, polled queue max 20, attribution TTL 60 s (hub), live-session staleness 30 s for `nowPlaying`.

## Vectors/parity

No `server/fixtures` set exists for this domain. Rust tests (`server/crates/server/tests/it/remote.rs`) cover the rules, including `canControl` over `(me: self/admin/other, targetUserId: null/self/other/missing, deviceId: ''/granted/ungranted, targetEnabled)` -> `{allowed, reason}` (rule 7) and the grant-code helpers (alphabet, length, `trim().toUpperCase()` normalization, expiry arithmetic).

Parity scenarios (`server/parity/scenarios/remote/`, 52 files, ignore paths `$..createdAt`, `$..cmdId`, `$..id` on grant rows, `$..code`, `$..expiresAt`):
- targets: `targets-empty`, `targets-self-filter`, `targets-after-register`, `targets-now-playing`, `targets-other-user-sees-none`, `targets-unauthenticated`, `targets-stream-token-forbidden`
- register: `register-ok` (201, `targetId` ends `#native`), `register-validation`, `register-unknown-field`, `register-unauthenticated`, `register-stream-token-forbidden`, `polled-target-keyed-by-user-and-device` (rule 21)
- commands (polled queue): `commands-drain-empty`, `commands-after-command`, `commands-offline`, `commands-other-user-offline`, `commands-missing-target-id` (rule 22), `commands-unauthenticated`, `commands-stream-token-forbidden`
- grants: `grant-code-ok`, `grant-code-too-many`, `grant-code-validation`, `grant-claim-ok`, `grant-claim-unknown-code`, `grant-claim-own-device`, `grant-claim-validation`, `grant-claim-lets-grantee-command`, `grants-list-empty`, `grants-list-device-filter`, `grant-revoke-ok`, `grant-revoke-not-found`, `grant-revoke-non-integer-id`, each with `-unauthenticated` and `-stream-token-forbidden` variants where listed
- command: `command-ok`, `command-offline`, `command-self-target`, `command-unknown-action`, `command-validation-level`, `command-other-user-denied`, `command-admin-controls-any-target`, `command-load-with-media`, `command-load-attributes-media`, `command-unauthenticated`, `command-stream-token-forbidden`.
Fan-out (`remote.state` and `remote.targets_changed` reaching grantees and admins) and the 30 s cache window are covered by Rust tests with two SSE streams: the revoke case asserts the `remote.targets_changed` arrival, not state silence.
