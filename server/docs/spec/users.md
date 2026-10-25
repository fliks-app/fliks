# Spec: users

Scope: users CRUD, stats and avatar storage. Authentication, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); this file only adds what is specific to users.

The update DTO has **26** fields (table in rule 20).

Out of scope: `/api/media-servers/*` is NOT served by this module (module `media-servers`).

## Routes

8 routes. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard` on all of them. `PublicUser` = rule 2. 401 for missing/invalid credentials on every route (auth rule 14). Declaration order matters for the router: `me/avatar` has 3 segments and cannot clash with `:id`; `GET /users/me` is NOT a route (it hits `:id` and fails the integer pipe with 400).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/users` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | none | `PublicUser[]` `ORDER BY username ASC` | 403 (auth rule 27) | none |
| `POST /api/users` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | body `CreateUserDto` (rule 12) | 201, `PublicUser` | 400 validation; 409 `Username already taken`; 403 `Only users with roles.manage permission can assign a role` | INSERT `users`, `library_user_access` |
| `GET /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Read, User)` (class level: any authenticated user passes) | path `id` integer | `PublicUser` | 400 `Validation failed (numeric string is expected)`; 404 `User #<id> not found`; 403 for other users unless `users.manage` | none |
| `PUT /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Update, User)` (class level: any authenticated user passes) | path `id`; body `UpdateUserDto` (rule 20) | `PublicUser` | 400; 404; 409 `Username already taken`; 403 (rules 14-18) | UPDATE `users`; library access replace; social teardown; SSE drop; engine revoke |
| `DELETE /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | path `id` | 200, no body | 404 `User #<id> not found` | DELETE `users` (FK cascades); engine revoke |
| `GET /api/users/:id/stats` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | path `id` | `UserStats` (rule 28) | 404 `User #<id> not found` | none |
| `POST /api/users/me/avatar` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `AnyAuthenticatedUser` | multipart, field `file`, <= 5 MiB, `image/jpeg` | 201, `PublicUser` | 400 `No image uploaded` / `Avatar must be a JPEG image` / `Unexpected field - <name>`; 413 `File too large`; 404 `User #<id> not found` | writes `<dataDir>/users/<id>.jpg`; `users.avatar` |
| `DELETE /api/users/me/avatar` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `AnyAuthenticatedUser` | none | `PublicUser` | 404 `User #<id> not found` | removes avatar files; `users.avatar = NULL` |

A scoped (`stream`) token is answered 401 on every one of these (auth rule 12).

## Rules

### A. Shape and reads

1. Policy results: `users.manage` (or `manage:all`) satisfies every `Manage User`/`Read User`/`Update User` check; everyone else satisfies only the two class-level `Read`/`Update` checks (auth rules 24, 26).
2. `PublicUser` JSON = all `users` columns except `passwordHash`, plus `role`, `permissions`, `libraryIds`; **no `features`** (auth-only). Types: `id number`, `createdAt/updatedAt ISO string`, `username string`, `email string|null`, `roleId number|null`, `mediaServerType 'local'|'jellyfin'|'emby'|'plex'`, `mediaServerId string|null`, `avatar string|null`, `lastLogin ISO|null`, `isAdmin bool`, `enabled bool`, `requirePasswordChange bool`, `movieQuotaLimit int`, `seriesQuotaLimit int`, `quotaPeriodDays int`, `libraryOrder int[]`, `hiddenLibraryIds int[]`, `profileVisibility 'public'|'private'`, `shareTastes shareRecommendations shareWatchHistory shareLikes shareStats shareDisabled hideSpoilers edlEnabled edlAutoSkipCommercials spoilerHideStills spoilerHideOverviews spoilerHideTitles` all bool. Column defaults: `mediaServerType 'local'`, `isAdmin false`, `enabled true`, `requirePasswordChange false`, `movieQuotaLimit 0`, `seriesQuotaLimit 0`, `quotaPeriodDays 7`, `libraryOrder []`, `hiddenLibraryIds []`, `profileVisibility 'private'`, `share* false`, `shareDisabled false`, `hideSpoilers false`, `edlEnabled true`, `edlAutoSkipCommercials true`, `spoilerHideStills/Overviews/Titles true`. `role` = role name or `null` (NO `'Admin'` fallback here, unlike auth `SafeUser`); `permissions` = auth rule 19; `libraryIds` = ids from `library_user_access`.
3. `findAll`: users `ORDER BY username ASC` (database collation) with role; library ids from one `IN` query over all returned users; a user with no rows gets `[]`; `[]` when there are no users. `libraryIds` order: `ORDER BY lua.id` (insertion order).
4. `findOne`: user by id with role else 404 `User #<id> not found`; `libraryIds` per rule 3.
5. `GET /api/users/:id` is allowed when `:id` is the caller or the caller has `users.manage`; otherwise 403 before any lookup (so a non-manager cannot probe existence). Body: bare 403 `{"message":"Forbidden","statusCode":403}` (same body for every bare 403 below).
6. `:id` path params use `ParseIntPipe` semantics: a non-integer string is 400 `Validation failed (numeric string is expected)`. Rust types the path as integer: non-canonical integers (`007`, `+7`) and ids beyond the integer column range are 400 too (a non-integer, non-canonical or out-of-range id is never a 500).

### B. Seeding

7. Nothing is seeded at boot: the first admin is created through `POST /api/auth/setup` (`auth.md` rule 38).

### C. Create

8. `POST /users` order: duplicate `username` (exact match) → 409 `Username already taken`; then, if `roleId !== undefined` (even `null`) and the requester lacks `manage Role` (`roles.manage` or `manage:all`) → 403 `Only users with roles.manage permission can assign a role`; then role resolution; then insert; then library access; then respond `findOne(newId)`.
9. Role resolution: if `roleId` is truthy look the role up by id; if it is falsy or not found, silently fall back to the role with `isDefault = true` (`roleId` becomes that role's id, or stays unset/NULL when there is no default role).
10. Insert values: `username`, `passwordHash = bcrypt12(password)`, `email` (as given, may be undefined), `roleId`, `isAdmin = dto.isAdmin ?? false`, `enabled = dto.enabled ?? true`; every other column takes its default. Only an admin (`isAdmin` caller) may create with `isAdmin: true`, else bare 403.
11. Initial library access: `dto.libraryIds` when present (even `[]`), else the resolved role's `defaultLibraryIds` (empty when no role); one `library_user_access` row per id. Not transactional: an unknown library id fails the insert after the user row exists (500).
12. `CreateUserDto`: `username` string (empty allowed); `password` string, length >= 8; `email?` valid email; `roleId?` number (any JSON number); `isAdmin?` bool; `enabled?` bool; `libraryIds?` int[]. All unknown keys 400.

### D. Update (`PUT /users/:id`)

13. Order of operations in `update` (everything before step 8 only mutates an in-memory copy; nothing is written until step 8): (1) load target with role, none → 404 `User #<id> not found`; (2) `isSelf = requester.id == id`, `isManager = can(manage, User)`; `!isSelf && !isManager` → 403 bare `{"message":"Forbidden","statusCode":403}`; (3) `username` change (rule 17); (4) `email`; (5) `password` (rule 17); (6) manager-only block or its 403 (rules 14-16); (7) all remaining fields (rule 20); (8) persist the user row (`UPDATE users SET <changed cols>, "updatedAt" = now()`); (9) social teardown if `shareDisabled` went false to true (rule 24); (10) `dropConnectionsForUser` if role or enabled changed (rule 25); (11) library access replace when `libraryIds` is present (rule 18); (12) engine revoke (rule 26); (13) respond `findOne(id)`.
14. Manager-only fields are `roleId`, `isAdmin`, `enabled`, `requirePasswordChange`. A non-manager (self) who sends ANY of them (`!== undefined`, even equal to the current value or `false`) gets 403 `Only users with users.manage permission can change role or enabled status` and nothing is persisted.
15. `roleChanging = dto.roleId !== undefined && dto.roleId !== target.roleId` (`null` counts as a value; a `null` target role differs from any number). A manager who is `roleChanging` without `manage Role` gets 403 `Only users with roles.manage permission can change a role`; re-sending the current `roleId` is allowed.
16. Manager block effects: `roleId` set (and the role relation set to `{id}` or `null`, which is why `roleId: null` clears the role), `isAdmin`, `enabled`, `requirePasswordChange` set when defined. Only an admin may set `isAdmin` (changing it) or modify an admin target (bare 403 otherwise); the last enabled admin cannot be deleted, disabled or demoted (409 `Cannot remove the last enabled admin`).
17. `username`: if defined, another user with that exact username (case-sensitive) → 409 `Username already taken`, else set (self may rename; JWTs issued earlier stay valid, auth rule 9). `password`: `bcrypt12`; when `isSelf`, `requirePasswordChange` is cleared to `false` (a manager changing someone else's password leaves the flag as is). A password change revokes every refresh-token family of the target and drops its SSE connections (after commit); the caller's access token stays valid until `exp`. `email` set as given.
18. `libraryIds` (replace-all): manager-only. For a non-manager the response is 403 `Only users with users.manage permission can change library access` and nothing from the request is persisted. The whole request is authorised first, so a 403 writes nothing; the writes run in one transaction. Manager: `DELETE FROM library_user_access WHERE "userId" = id`, then insert one row per id (nothing inserted for `[]`).
19. `movieQuotaLimit`, `seriesQuotaLimit` and `quotaPeriodDays` need `users.manage` (bare 403 otherwise); preferences stay self-writable.
20. `UpdateUserDto` fields (26; every one optional; unknown keys 400; `null` passes validation, see rule 21). "Who": S = self may set, M = needs `users.manage`.

    | Field | Constraint | Who | Effect |
    |---|---|---|---|
    | `username` | string | S, M | rule 17 |
    | `email` | valid email | S, M | set |
    | `password` | string, length >= 8 | S, M | rule 17 |
    | `roleId` | number | M (+ `roles.manage` if changing) | rules 15, 16 |
    | `isAdmin` | bool | M | set; triggers engine revoke if changed |
    | `enabled` | bool | M | set; drop connections if changed; engine revoke if `false` |
    | `requirePasswordChange` | bool | M | set |
    | `movieQuotaLimit` | number >= 0 | M | set |
    | `seriesQuotaLimit` | number >= 0 | M | set |
    | `quotaPeriodDays` | number >= 1 | M | set |
    | `libraryIds` | int[], must not contain `0` | M | rule 18 |
    | `libraryOrder` | int[] | S, M | set (replaces; no existence check, duplicates kept) |
    | `hiddenLibraryIds` | int[] | S, M | set (same) |
    | `profileVisibility` | `'public'\|'private'` | S, M | set |
    | `shareTastes` | bool | S, M | set |
    | `shareRecommendations` | bool | S, M | set |
    | `shareWatchHistory` | bool | S, M | set |
    | `shareLikes` | bool | S, M | set |
    | `shareStats` | bool | S, M | set |
    | `shareDisabled` | bool | S, M | rule 24 on false to true |
    | `hideSpoilers` | bool | S, M | set |
    | `edlEnabled` | bool | S, M | set |
    | `edlAutoSkipCommercials` | bool | S, M | set |
    | `spoilerHideStills` | bool | S, M | set |
    | `spoilerHideOverviews` | bool | S, M | set |
    | `spoilerHideTitles` | bool | S, M | set |

21. `@IsOptional()` skips validation for both `undefined` and `null`, and the service tests `!== undefined`, so a `null` field is "present": `roleId: null` clears the role (rules 15-16), `email: null` stores NULL; for the other fields `null` reaches the column or `bcrypt` and ends as an error (500; unverifiable without running). A `null` on a non-nullable field is answered 400 (standard validation body); `roleId` and `email` keep accepting `null`.
22. Non-integer JSON numbers for `roleId` and the quota fields are accepted by validation (`IsNumber`, not `IsInt`) and then fail at the integer column (500).
23. The update is not transactional: user save, teardown, library replace are separate statements, concurrent updates are last-write-wins per column set.

### E. Side effects

24. Social teardown, once, when `dto.shareDisabled === true && target.shareDisabled !== true`, after the row is saved (statements quoted verbatim in SQL; no SSE event).
25. SSE drop: when `roleChanging || enabledChanging` (`dto.enabled !== undefined && dto.enabled !== target.enabled`, so enabling also drops) call `dropConnectionsForUser(id)`: completes every SSE connection owned by the user and deletes their polled targets, then emits `remote.targets_changed` to the user if a polled target was dropped. It is also called from `remove` and for a password change, not for `isAdmin` or library changes.
26. Engine revoke, fire-and-forget (never awaited, never changes the response): after update when `dto.enabled === false || roleChanging || adminChanging || dto.libraryIds !== undefined` (`adminChanging = dto.isAdmin !== undefined && dto.isAdmin !== target.isAdmin`; `enabled === false` fires even if already disabled; `libraryIds` fires even if unchanged), and after `remove`. Call: `POST /v1/revoke` body `{"ownerId": "<id as string>"}` on the engine, only when the engine's `hello.features` contains `revoke`; errors and non-2xx are logged and swallowed. Profile edits do not revoke. The engine client is called directly.

### F. Delete

27. `DELETE /users/:id`: user not found → 404 `User #<id> not found`; `DELETE FROM users WHERE id = $1` (all dependants go through the schema's `ON DELETE CASCADE`/`SET NULL`, owned by the migrations); then engine revoke (rule 26); 200 with an empty body. An admin target needs an admin caller and the last enabled admin is 409 (rule 16); the user's SSE connections are dropped (rule 25); the avatar files stay on disk.

### G. Stats

28. `GET /users/:id/stats`: 404 `User #<id> not found`, else `{playback: {totalWatchTimeSeconds: int, moviesWatched: int, seriesStarted: int, episodesWatched: int, lastPlayedAt: ISO|null}, requests: {pending: int, approved: int, declined: int}, activity: {lastActiveAt: ISO|null, memberSince: ISO}}`. `totalWatchTimeSeconds = Math.round(SUM)` (round half up); counts are numbers; `lastPlayedAt` = `MAX(lastPlayedAt)` as ISO-8601 with ms; `lastActiveAt` = `users.lastLogin`; `memberSince` = `users.createdAt`; request statuses other than the three are not reported.
29. The social module reuses the same two aggregation queries for a user's stats.

### H. Avatar

30. `POST /users/me/avatar`: the upload is buffered in memory with a 5 MiB limit; a file field other than `file` → 400 `Unexpected field - <name>`; a file over 5 242 880 bytes → 413 `{"message":"File too large","error":"Payload Too Large","statusCode":413}` (the media-upload too-large message is NOT used here).
31. Service checks in order: no file or an empty buffer (also a non-multipart request) → 400 `No image uploaded`; part `Content-Type` is not exactly `image/jpeg` → 400 `Avatar must be a JPEG image` (no magic-byte or dimension check; the client crops and downsizes); user row missing → 404 `User #<id> not found`.
32. Storage: write the bytes to `<dataDir>/users/<id>.jpg` (`mkdir -p`, overwrite; `<dataDir>` as in `config.md` `FLIKS_DATA_DIR`), set `users.avatar = '/api/images/user/<id>?v=<Date.now() ms>'`, respond `findOne(id)`.
33. `DELETE /users/me/avatar`: user missing → 404; unlink `users/<id>.jpg`, `users/<id>-thumb.jpg`, `users/<id>-medium.jpg` and the sidecar `users/<id>.src.json` (missing files ignored); `avatar = NULL`; respond `findOne(id)`. Serving the image is the images module (`GET /api/images/user/:id`).
34. Both avatar routes act on the caller only (`user.id` from the token); no id in the path.

## SQL

Tables `users`, `roles`, `library_user_access` (`"userId"`, `"libraryId"`, unique pair, FK cascade), `role_default_libraries`. Calls are written as equivalent SQL.

- List: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" ORDER BY u.username ASC`; then `SELECT lua."userId" AS "userId", lua."libraryId" AS "libraryId" FROM library_user_access lua WHERE lua."userId" IN ($1,...)` (add `ORDER BY lua.id`, rule 3).
- One: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`; ids: `SELECT lua."libraryId" AS "libraryId" FROM library_user_access lua WHERE lua."userId" = $1`.
- Create: `SELECT... FROM users WHERE username = $1`; role `SELECT... FROM roles WHERE id = $1` / `WHERE "isDefault" = true`; `INSERT INTO users (username, "passwordHash", email, "roleId", "isAdmin", enabled) VALUES (...) RETURNING id, "createdAt", "updatedAt", <default columns>`; `INSERT INTO library_user_access ("userId", "libraryId") VALUES...`.
- Update: `UPDATE users SET <changed columns>, "updatedAt" = now() WHERE id = $1`; library replace `DELETE FROM library_user_access WHERE "userId" = $1` then bulk `INSERT`.
- Delete: `DELETE FROM users WHERE id = $1`.
- Social teardown, verbatim (each `$1` = the user id, executed in this order):
  ```sql
  DELETE FROM user_follows WHERE "followerId" = $1 OR "followingId" = $1
  DELETE FROM playlist_saves WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1)
  UPDATE playlists SET visibility = 'private' WHERE "ownerId" = $1 AND visibility <> 'private'
  DELETE FROM content_recommendations WHERE "senderId" = $1 OR "recipientId" = $1
  ```
- Stats:
  ```sql
  SELECT COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0) AS "totalWatchTimeSeconds",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'movie' THEN ps."mediaId" END) AS "moviesWatched",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'series' THEN ps."mediaId" END) AS "seriesStarted",
         COUNT(DISTINCT CASE WHEN ps.completed AND ps."episodeId" IS NOT NULL THEN ps."episodeId" END) AS "episodesWatched",
         MAX(ps."lastPlayedAt") AS "lastPlayedAt"
  FROM playback_states ps LEFT JOIN media ON media.id = ps."mediaId"
  WHERE ps."userId" = $1
  ```
  and: `SELECT r.status AS status, COUNT(*) AS count FROM requests r WHERE r."userId" = $1 GROUP BY r.status` (map `pending`, `approved`, `declined`; absent = 0).
- Avatar: `UPDATE users SET avatar = $1, "updatedAt" = now() WHERE id = $2` (value `NULL` on clear).

## Events

SSE, indirect only: `dropConnectionsForUser` completes the user's SSE responses and may emit `remote.targets_changed` (audience: that user); produced by the SSE hub. No other event is emitted by users routes (no `user.updated`).

## Settings keys

none

## Jobs/timers

none (boot-time admin seed only, rule 7)

## Vectors/parity

No fixture set for users. The permission predicates rely on the `acl` set (`auth.md`). Rust unit tests: the 26-field authorisation matrix (S vs M, each `403` message) and the engine-revoke condition table.

Parity scenarios: one file per case in `server/parity/scenarios/users/` The seed needs a `users.manage`-without-`roles.manage` account (`users/create-manager-with-role-forbidden`), and the runner's multipart step covers the avatar scenarios. SSE drop and engine revoke are not observable through HTTP parity (the parity engine is a stub): covered by Rust tests.

## Open questions

None.
