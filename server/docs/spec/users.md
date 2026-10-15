# Spec: users

Sources: `[ts:src/modules/users/users.controller.ts]`, `[ts:src/modules/users/users.service.ts]`, `[ts:src/modules/users/users-stats.service.ts]`, `[ts:src/modules/users/dto/*.ts]`, `[ts:src/modules/users/entities/user.entity.ts]`, avatar storage `[ts:src/modules/images/image.service.ts]`. Milestone: S1. Authentication, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); this file only adds what is specific to users.

Plan §3.2 cites `users.service.ts:373-517` for the "25-field authz": the file has 398 lines, the authorisation is `update()` at `:212`–`:356` and the DTO has **26** fields (table in rule 20).

Out of scope (milestone S5): `/api/media-servers/*` is NOT served by this module. Its controller is `[ts:src/modules/media-servers/media-servers.controller.ts]` (module `media-servers`, plan §10 S5). Only the entity file `[ts:src/modules/users/entities/media-server.entity.ts]` lives under `users/` and `UsersModule` registers its repository; it stays in Nest until S5 (see Deletes).

## Routes

8 routes (manifest filter: `.[]|select(.file|test("modules/users/"))`). Class-level guards `JwtOrApiKeyGuard, PoliciesGuard` on all of them `[ts:src/modules/users/users.controller.ts:30]`. `PublicUser` = rule 2. 401 for missing/invalid credentials on every route (auth rule 14). Declaration order matters for the router: `me/avatar` has 3 segments and cannot clash with `:id`; `GET /users/me` is NOT a route (it hits `:id` and fails the integer pipe with 400).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/users` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | none | `PublicUser[]` `ORDER BY username ASC` | 403 (auth rule 27) | none |
| `POST /api/users` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | body `CreateUserDto` (rule 12) | 201, `PublicUser` | 400 validation; 409 `Username already taken`; 403 `Only users with roles.manage permission can assign a role` | INSERT `users`, `library_user_access` |
| `GET /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Read, User)` (class level: any authenticated user passes) | path `id` integer | `PublicUser` | 400 `Validation failed (numeric string is expected)`; 404 `User #<id> not found`; **F2: 403 for other users unless `users.manage`** | none |
| `PUT /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Update, User)` (class level: any authenticated user passes) | path `id`; body `UpdateUserDto` (rule 20) | `PublicUser` | 400; 404; 409 `Username already taken`; 403 (rules 14-18) | UPDATE `users`; library access replace; social teardown; SSE drop; engine revoke |
| `DELETE /api/users/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | path `id` | 200, no body | 404 `User #<id> not found` | DELETE `users` (FK cascades); engine revoke |
| `GET /api/users/:id/stats` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, User)` | path `id` | `UserStats` (rule 28) | 404 `User #<id> not found` | none |
| `POST /api/users/me/avatar` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `AnyAuthenticatedUser` | multipart, field `file`, <= 5 MiB, `image/jpeg` | 201, `PublicUser` | 400 `No image uploaded` / `Avatar must be a JPEG image` / `Unexpected field - <name>`; 413 `File too large`; 404 `User #<id> not found` | writes `<dataDir>/users/<id>.jpg`; `users.avatar` |
| `DELETE /api/users/me/avatar` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `AnyAuthenticatedUser` | none | `PublicUser` | 404 `User #<id> not found` | removes avatar files; `users.avatar = NULL` |

`[ts:src/modules/users/users.controller.ts:38]`–`[ts:src/modules/users/users.controller.ts:102]`. A scoped (`stream`) token passes every one of these (auth rule 12).

## Rules

### A. Shape and reads

1. Policy results: `users.manage` (or `manage:all`) satisfies every `Manage User`/`Read User`/`Update User` check; everyone else satisfies only the two class-level `Read`/`Update` checks (auth rules 24, 26). `[ts:src/modules/auth/casl/casl-ability.factory.ts:71]`–`[ts:src/modules/auth/casl/casl-ability.factory.ts:73]`, `[ts:src/modules/auth/casl/casl-ability.factory.ts:143]`–`[ts:src/modules/auth/casl/casl-ability.factory.ts:147]`
2. `PublicUser` JSON = all `users` columns except `passwordHash`, plus `role`, `permissions`, `libraryIds`; **no `features`** (auth-only). Types: `id number`, `createdAt/updatedAt ISO string`, `username string`, `email string|null`, `roleId number|null`, `mediaServerType 'local'|'jellyfin'|'emby'|'plex'`, `mediaServerId string|null`, `avatar string|null`, `lastLogin ISO|null`, `isAdmin bool`, `enabled bool`, `requirePasswordChange bool`, `movieQuotaLimit int`, `seriesQuotaLimit int`, `quotaPeriodDays int`, `libraryOrder int[]`, `hiddenLibraryIds int[]`, `profileVisibility 'public'|'private'`, `shareTastes shareRecommendations shareWatchHistory shareLikes shareStats shareDisabled hideSpoilers edlEnabled edlAutoSkipCommercials spoilerHideStills spoilerHideOverviews spoilerHideTitles` all bool. Column defaults: `mediaServerType 'local'`, `isAdmin false`, `enabled true`, `requirePasswordChange false`, `movieQuotaLimit 0`, `seriesQuotaLimit 0`, `quotaPeriodDays 7`, `libraryOrder []`, `hiddenLibraryIds []`, `profileVisibility 'private'`, `share* false`, `shareDisabled false`, `hideSpoilers false`, `edlEnabled true`, `edlAutoSkipCommercials true`, `spoilerHideStills/Overviews/Titles true`. `role` = role name or `null` (NO `'Admin'` fallback here, unlike auth `SafeUser`); `permissions` = auth rule 19; `libraryIds` = ids from `library_user_access`. `passwordHash` is `select:false` + `@Exclude`; the serialised object is a plain object, so class-transformer does nothing. `[ts:src/modules/users/users.service.ts:144]`–`[ts:src/modules/users/users.service.ts:153]`, `[ts:src/modules/users/entities/user.entity.ts:9]`–`[ts:src/modules/users/entities/user.entity.ts:160]`
3. `findAll`: users `ORDER BY username ASC` (database collation) with role; library ids from one `IN` query over all returned users; a user with no rows gets `[]`; `[]` when there are no users. `libraryIds` order: Nest has no `ORDER BY` (physical order); Rust uses `ORDER BY lua.id` `[assumed]` (insertion order is what Postgres returns in practice; unverifiable, record a parity scenario). `[ts:src/modules/users/users.service.ts:71]`–`[ts:src/modules/users/users.service.ts:89]`
4. `findOne`: user by id with role else 404 `User #<id> not found`; `libraryIds` per rule 3. `[ts:src/modules/users/users.service.ts:91]`–`[ts:src/modules/users/users.service.ts:99]`, `[ts:src/modules/users/users.service.ts:134]`–`[ts:src/modules/users/users.service.ts:141]`
5. **F2** `[new]`: `GET /api/users/:id` is allowed when `:id` is the caller or the caller has `users.manage`; otherwise 403 before any lookup (so a non-manager cannot probe existence). Body: bare 403 `{"message":"Forbidden","statusCode":403}` `[assumed]` (plan F2 fixes the status only; mirrors the bare `ForbiddenException()` of rule 13 step 2, see Open questions Q5). Nest today returns any user, including other accounts' `email`, `lastLogin` and `permissions`, to any authenticated token. `[ts:src/modules/users/users.controller.ts:73]`–`[ts:src/modules/users/users.controller.ts:77]` (plan §7.6 F2)
6. `:id` path params use `ParseIntPipe` semantics: a non-integer string is 400 `Validation failed (numeric string is expected)`. Rust types the path as integer; ids beyond the integer column range are `[assumed]` 404 (Nest would hit a Postgres range error). `[ts:src/modules/users/users.controller.ts:75]`

### B. Seeding

7. At boot, if `users` is empty: insert `{username:'admin', passwordHash: bcrypt12('password'), isAdmin: true, enabled: true}` (no `roleId`, `requirePasswordChange` stays `false`, `email` null); logs two warnings. The seed stays under F1 (user decision 2026-10-15). Rust runs it after migrations, before listening; the Nest `onModuleInit` is deleted. `[ts:src/modules/users/users.service.ts:52]`–`[ts:src/modules/users/users.service.ts:69]`

### C. Create

8. `POST /users` order: duplicate `username` (exact match) → 409 `Username already taken`; then, if `roleId !== undefined` (even `null`) and the requester lacks `manage Role` (`roles.manage` or `manage:all`) → 403 `Only users with roles.manage permission can assign a role`; then role resolution; then insert; then library access; then respond `findOne(newId)`. `[ts:src/modules/users/users.service.ts:155]`–`[ts:src/modules/users/users.service.ts:206]`
9. Role resolution: if `roleId` is truthy look the role up by id; if it is falsy or not found, silently fall back to the role with `isDefault = true` (`roleId` becomes that role's id, or stays unset/NULL when there is no default role). `[ts:src/modules/users/users.service.ts:168]`–`[ts:src/modules/users/users.service.ts:176]`
10. Insert values: `username`, `passwordHash = bcrypt12(password)`, `email` (as given, may be undefined), `roleId`, `isAdmin = dto.isAdmin ?? false`, `enabled = dto.enabled ?? true`; every other column takes its default. Note: `isAdmin` is accepted from any caller who passes `Manage User` (no `roles.manage` check), see Q1. `[ts:src/modules/users/users.service.ts:178]`–`[ts:src/modules/users/users.service.ts:186]`
11. Initial library access: `dto.libraryIds` when present (even `[]`), else the resolved role's `defaultLibraryIds` (empty when no role); one `library_user_access` row per id. Not transactional: an unknown library id fails the insert after the user row exists (`[assumed]` 500). `[ts:src/modules/users/users.service.ts:190]`–`[ts:src/modules/users/users.service.ts:203]`
12. `CreateUserDto`: `username` string (empty allowed); `password` string, length >= 8; `email?` valid email; `roleId?` number (any JSON number); `isAdmin?` bool; `enabled?` bool; `libraryIds?` int[]. All unknown keys 400. `[ts:src/modules/users/dto/create-user.dto.ts:12]`–`[ts:src/modules/users/dto/create-user.dto.ts:41]`

### D. Update (`PUT /users/:id`)

13. Order of operations in `update` (everything before step 8 only mutates an in-memory copy; nothing is written until step 8): (1) load target with role, none → 404 `User #<id> not found`; (2) `isSelf = requester.id == id`, `isManager = can(manage, User)`; `!isSelf && !isManager` → 403 bare `{"message":"Forbidden","statusCode":403}`; (3) `username` change (rule 17); (4) `email`; (5) `password` (rule 17); (6) manager-only block or its 403 (rules 14-16); (7) all remaining fields (rule 20); (8) persist the user row (`UPDATE users SET <changed cols>, "updatedAt" = now()`); (9) social teardown if `shareDisabled` went false to true (rule 24); (10) `dropConnectionsForUser` if role or enabled changed (rule 25); (11) library access replace when `libraryIds` is present (rule 18); (12) engine revoke (rule 26); (13) respond `findOne(id)`. `[ts:src/modules/users/users.service.ts:212]`–`[ts:src/modules/users/users.service.ts:356]`
14. Manager-only fields are `roleId`, `isAdmin`, `enabled`, `requirePasswordChange`. A non-manager (self) who sends ANY of them (`!== undefined`, even equal to the current value or `false`) gets 403 `Only users with users.manage permission can change role or enabled status` and nothing is persisted. `[ts:src/modules/users/users.service.ts:273]`–`[ts:src/modules/users/users.service.ts:282]`
15. `roleChanging = dto.roleId !== undefined && dto.roleId !== target.roleId` (`null` counts as a value; a `null` target role differs from any number). A manager who is `roleChanging` without `manage Role` gets 403 `Only users with roles.manage permission can change a role`; re-sending the current `roleId` is allowed. `[ts:src/modules/users/users.service.ts:250]`, `[ts:src/modules/users/users.service.ts:255]`–`[ts:src/modules/users/users.service.ts:260]`
16. Manager block effects: `roleId` set (and the role relation set to `{id}` or `null`, which is why `roleId: null` clears the role), `isAdmin`, `enabled`, `requirePasswordChange` set when defined. There is no guard against self-demotion, self-disable, disabling or demoting the last admin, or a `users.manage` holder setting `isAdmin` on anyone (Q1). `[ts:src/modules/users/users.service.ts:255]`–`[ts:src/modules/users/users.service.ts:272]`
17. `username`: if defined, another user with that exact username (case-sensitive) → 409 `Username already taken`, else set (self may rename; old JWTs stay valid, auth rule 9). `password`: `bcrypt12`; when `isSelf`, `requirePasswordChange` is cleared to `false` (a manager changing someone else's password leaves the flag as is). `email` set as given. `[ts:src/modules/users/users.service.ts:228]`–`[ts:src/modules/users/users.service.ts:245]`
18. `libraryIds` (replace-all): manager-only. For a non-manager the 403 `Only users with users.manage permission can change library access` is thrown AFTER steps 8-10 of rule 13 ran, so every other field in that request IS persisted (and social teardown / connection drop ran) while the response is 403. Manager: `DELETE FROM library_user_access WHERE "userId" = id`, then insert one row per id (nothing inserted for `[]`), not transactional. Nest behaviour recorded for parity; whether Rust keeps the partial write is Q2. `[ts:src/modules/users/users.service.ts:330]`–`[ts:src/modules/users/users.service.ts:349]`
19. Quotas and preferences are NOT behind the manager gate: any caller who reaches `update` as self can set their own `movieQuotaLimit`, `seriesQuotaLimit`, `quotaPeriodDays` (Q3). `[ts:src/modules/users/users.service.ts:284]`–`[ts:src/modules/users/users.service.ts:289]`
20. `UpdateUserDto` fields (26; every one optional; unknown keys 400; `null` passes validation, see rule 21). "Who": S = self may set, M = needs `users.manage`. `[ts:src/modules/users/dto/update-user.dto.ts:16]`

    | Field | Constraint | Who | Effect |
    |---|---|---|---|
    | `username` | string | S, M | rule 17 |
    | `email` | valid email | S, M | set |
    | `password` | string, length >= 8 | S, M | rule 17 |
    | `roleId` | number | M (+ `roles.manage` if changing) | rules 15, 16 |
    | `isAdmin` | bool | M | set; triggers engine revoke if changed |
    | `enabled` | bool | M | set; drop connections if changed; engine revoke if `false` |
    | `requirePasswordChange` | bool | M | set |
    | `movieQuotaLimit` | number >= 0 | S, M | set |
    | `seriesQuotaLimit` | number >= 0 | S, M | set |
    | `quotaPeriodDays` | number >= 1 | S, M | set |
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

    `[ts:src/modules/users/dto/update-user.dto.ts:16]`–`[ts:src/modules/users/dto/update-user.dto.ts:145]`, application `[ts:src/modules/users/users.service.ts:284]`–`[ts:src/modules/users/users.service.ts:325]`
21. `@IsOptional()` skips validation for both `undefined` and `null`, and the service tests `!== undefined`, so a `null` field is "present": `roleId: null` clears the role (rules 15-16), `email: null` stores NULL; for the other fields `null` reaches the column or `bcrypt` and ends as an error (`[assumed]` 500; unverifiable without running). Rust behaviour for `null` on non-nullable fields is Q4. `[ts:src/modules/users/dto/update-user.dto.ts:17]`–`[ts:src/modules/users/dto/update-user.dto.ts:28]`
22. Non-integer JSON numbers pass `IsNumber` for `roleId` and the quota fields and then fail at the integer column (`[assumed]` 500; the DTO states `IsNumber`, not `IsInt`). `[ts:src/modules/users/dto/update-user.dto.ts:30]`–`[ts:src/modules/users/dto/update-user.dto.ts:60]`
23. The update is not transactional: user save, teardown, library replace are separate statements, concurrent updates are last-write-wins per column set. `[ts:src/modules/users/users.service.ts:325]`–`[ts:src/modules/users/users.service.ts:349]`

### E. Side effects

24. Social teardown, once, when `dto.shareDisabled === true && target.shareDisabled !== true`, after the row is saved (raw SQL, quoted verbatim in SQL; no transaction; no SSE event). `[ts:src/modules/users/users.service.ts:318]`–`[ts:src/modules/users/users.service.ts:327]`, `[ts:src/modules/users/users.service.ts:365]`–`[ts:src/modules/users/users.service.ts:390]`
25. SSE drop: when `roleChanging || enabledChanging` (`dto.enabled !== undefined && dto.enabled !== target.enabled`, so enabling also drops) call `dropConnectionsForUser(id)`: completes every SSE connection owned by the user and deletes their polled targets, then emits `remote.targets_changed` to the user if a polled target was dropped. Needs bridge `drop-connections` in S1 (the hub is in Nest until S2). Not called by `remove`, by `isAdmin` changes, or by library changes. `[ts:src/modules/users/users.service.ts:247]`–`[ts:src/modules/users/users.service.ts:252]`, `[ts:src/modules/users/users.service.ts:328]`, hub `[ts:src/modules/scheduler/events.service.ts:651]`–`[ts:src/modules/scheduler/events.service.ts:676]`
26. Engine revoke, fire-and-forget (never awaited, never changes the response): after update when `dto.enabled === false || roleChanging || adminChanging || dto.libraryIds !== undefined` (`adminChanging = dto.isAdmin !== undefined && dto.isAdmin !== target.isAdmin`; `enabled === false` fires even if already disabled; `libraryIds` fires even if unchanged), and after `remove`. Call: `POST /v1/revoke` body `{"ownerId": "<id as string>"}` on the engine, only when the engine's `hello.features` contains `revoke`; errors and non-2xx are logged and swallowed. Profile edits do not revoke. Rust uses the S1 minimal engine client directly (no bridge). `[ts:src/modules/users/users.service.ts:351]`–`[ts:src/modules/users/users.service.ts:353]`, `[ts:src/modules/users/users.service.ts:396]`, `[ts:src/modules/engine/engine.service.ts:477]`–`[ts:src/modules/engine/engine.service.ts:487]`; unit spec `[ts:src/modules/users/users.service.revoke.spec.ts:43]`–`[ts:src/modules/users/users.service.revoke.spec.ts:63]`

### F. Delete

27. `DELETE /users/:id`: user not found → 404 `User #<id> not found`; `DELETE FROM users WHERE id = $1` (all dependants go through the schema's `ON DELETE CASCADE`/`SET NULL`, owned by the S0 migrations); then engine revoke (rule 26); 200 with an empty body. No self-delete or last-admin guard, no SSE drop, and the avatar files stay on disk. `[ts:src/modules/users/users.service.ts:392]`–`[ts:src/modules/users/users.service.ts:397]`

### G. Stats

28. `GET /users/:id/stats`: 404 `User #<id> not found`, else `{playback: {totalWatchTimeSeconds: int, moviesWatched: int, seriesStarted: int, episodesWatched: int, lastPlayedAt: ISO|null}, requests: {pending: int, approved: int, declined: int}, activity: {lastActiveAt: ISO|null, memberSince: ISO}}`. `totalWatchTimeSeconds = Math.round(SUM)` (round half up); counts are numbers; `lastPlayedAt` = `MAX(lastPlayedAt)` as ISO-8601 with ms; `lastActiveAt` = `users.lastLogin`; `memberSince` = `users.createdAt`; request statuses other than the three are not reported. `[ts:src/modules/users/users-stats.service.ts:27]`–`[ts:src/modules/users/users-stats.service.ts:110]`, shape `[ts:src/modules/users/dto/user-stats.dto.ts:8]`–`[ts:src/modules/users/dto/user-stats.dto.ts:27]`
29. Duplicate: the social module still calls `UsersStatsService.getUserStats` in Nest until S4, so the two aggregation queries exist in Nest and Rust between S1 and S4 (Q6). `[ts:src/modules/social/social.service.ts:463]`

### H. Avatar

30. `POST /users/me/avatar`: interceptor `FileInterceptor('file', {limits:{fileSize: 5 MiB}})` with memory storage; a file field other than `file` → 400 `Unexpected field - <name>`; a file over 5 242 880 bytes → 413 `{"message":"File too large","error":"Payload Too Large","statusCode":413}` (the media-upload `FileTooLargeFilter` is NOT applied here, so the message is Multer's, not `file_info.import_err_too_large`). `[ts:src/modules/users/users.controller.ts:53]`–`[ts:src/modules/users/users.controller.ts:63]`
31. Service checks in order: no file or an empty buffer (also a non-multipart request) → 400 `No image uploaded`; part `Content-Type` is not exactly `image/jpeg` → 400 `Avatar must be a JPEG image` (no magic-byte or dimension check; the client crops and downsizes); user row missing → 404 `User #<id> not found`. `[ts:src/modules/users/users.service.ts:106]`–`[ts:src/modules/users/users.service.ts:122]`
32. Storage: write the bytes to `<dataDir>/users/<id>.jpg` (`mkdir -p`, overwrite; `<dataDir>` as in `config.md` `FLIKS_DATA_DIR`), set `users.avatar = '/api/images/user/<id>?v=<Date.now() ms>'`, respond `findOne(id)`. `[ts:src/modules/images/image.service.ts:469]`–`[ts:src/modules/images/image.service.ts:474]`, `[ts:src/modules/images/image.service.ts:458]`–`[ts:src/modules/images/image.service.ts:459]`, `[ts:src/modules/images/image.service.ts:510]`–`[ts:src/modules/images/image.service.ts:511]`
33. `DELETE /users/me/avatar`: user missing → 404; unlink `users/<id>.jpg`, `users/<id>-thumb.jpg`, `users/<id>-medium.jpg` and the sidecar `users/<id>.src.json` (missing files ignored); `avatar = NULL`; respond `findOne(id)`. Serving the image is the images module (S3, `GET /api/images/user/:id`). `[ts:src/modules/users/users.service.ts:125]`–`[ts:src/modules/users/users.service.ts:132]`, `[ts:src/modules/images/image.service.ts:396]`–`[ts:src/modules/images/image.service.ts:416]`
34. Both avatar routes act on the caller only (`user.id` from the token); no id in the path. `[ts:src/modules/users/users.controller.ts:58]`–`[ts:src/modules/users/users.controller.ts:70]`

## SQL

Tables `users`, `roles`, `library_user_access` (`"userId"`, `"libraryId"`, unique pair, FK cascade `[ts:src/modules/libraries/entities/library-user-access.entity.ts:17]`–`[ts:src/modules/libraries/entities/library-user-access.entity.ts:31]`), `role_default_libraries`. DDL is S0's. TypeORM calls written as equivalent SQL.

- List `[ts:src/modules/users/users.service.ts:72]`: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" ORDER BY u.username ASC`; then `SELECT lua."userId" AS "userId", lua."libraryId" AS "libraryId" FROM library_user_access lua WHERE lua."userId" IN ($1,...)` `[ts:src/modules/users/users.service.ts:77]` (add `ORDER BY lua.id`, rule 3).
- One `[ts:src/modules/users/users.service.ts:92]`: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`; ids `[ts:src/modules/users/users.service.ts:135]`: `SELECT lua."libraryId" AS "libraryId" FROM library_user_access lua WHERE lua."userId" = $1`.
- Create `[ts:src/modules/users/users.service.ts:156]`: `SELECT ... FROM users WHERE username = $1`; role `SELECT ... FROM roles WHERE id = $1` / `WHERE "isDefault" = true`; `INSERT INTO users (username, "passwordHash", email, "roleId", "isAdmin", enabled) VALUES (...) RETURNING id, "createdAt", "updatedAt", <default columns>`; `INSERT INTO library_user_access ("userId", "libraryId") VALUES ...`.
- Update `[ts:src/modules/users/users.service.ts:325]`: `UPDATE users SET <changed columns>, "updatedAt" = now() WHERE id = $1`; library replace `DELETE FROM library_user_access WHERE "userId" = $1` then bulk `INSERT` `[ts:src/modules/users/users.service.ts:338]`.
- Delete `[ts:src/modules/users/users.service.ts:395]`: `DELETE FROM users WHERE id = $1`.
- Social teardown, verbatim `[ts:src/modules/users/users.service.ts:368]`–`[ts:src/modules/users/users.service.ts:389]` (each `$1` = the user id, executed in this order):
  ```sql
  DELETE FROM user_follows WHERE "followerId" = $1 OR "followingId" = $1
  DELETE FROM playlist_saves WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1)
  UPDATE playlists SET visibility = 'private' WHERE "ownerId" = $1 AND visibility <> 'private'
  DELETE FROM content_recommendations WHERE "senderId" = $1 OR "recipientId" = $1
  ```
- Stats `[ts:src/modules/users/users-stats.service.ts:53]` (TypeORM query builder, equivalent):
  ```sql
  SELECT COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0) AS "totalWatchTimeSeconds",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'movie' THEN ps."mediaId" END) AS "moviesWatched",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'series' THEN ps."mediaId" END) AS "seriesStarted",
         COUNT(DISTINCT CASE WHEN ps.completed AND ps."episodeId" IS NOT NULL THEN ps."episodeId" END) AS "episodesWatched",
         MAX(ps."lastPlayedAt") AS "lastPlayedAt"
  FROM playback_states ps LEFT JOIN media ON media.id = ps."mediaId"
  WHERE ps."userId" = $1
  ```
  and `[ts:src/modules/users/users-stats.service.ts:97]`: `SELECT r.status AS status, COUNT(*) AS count FROM requests r WHERE r."userId" = $1 GROUP BY r.status` (map `pending`, `approved`, `declined`; absent = 0).
- Avatar: `UPDATE users SET avatar = $1, "updatedAt" = now() WHERE id = $2` (value `NULL` on clear).

## Events

SSE, indirect only: `dropConnectionsForUser` completes the user's SSE responses and may emit `remote.targets_changed` (audience: that user) `[ts:src/modules/scheduler/events.service.ts:672]`–`[ts:src/modules/scheduler/events.service.ts:676]`; produced inside the Nest hub, reached through bridge `drop-connections`. No other event is emitted by users routes (no `user.updated`).

## Settings keys

none

## Jobs/timers

none (boot-time admin seed only, rule 7)

## Bridges

- `POST /internal/bridge/drop-connections` (Nest): payload `userId` (account-wide drop, rule 25). Shared with auth logout (`userId, targetId`); shape is owned by `bridge.md`. Added S1, removed S2.
- Engine revoke is a direct Rust call to the engine (S1 minimal engine client), not a bridge.

## Deletes in Nest

S1 (plan §10: "`M/users/**`") reduced by importers still in Nest (grep on `backend/src` outside `modules/users`): `user.entity.ts` is imported by 8+ modules; `media-server.entity.ts` by `modules/media-servers/*` (S5); `UsersStatsService` + `user-stats.dto.ts` by `modules/social/social.service.ts:28,29,112,463` (S4); `UsersModule` by `app.module.ts` and `social.module.ts`.

Delete:
- `backend/src/modules/users/users.controller.ts`
- `backend/src/modules/users/users.service.ts` (admin seed, CRUD, avatar, `leaveSocial`, `PublicUser` type; its only outside importer is `auth.service.ts`, trimmed per auth.md)
- `backend/src/modules/users/users.service.role-assignment.spec.ts`
- `backend/src/modules/users/users.service.revoke.spec.ts`
- `backend/src/modules/users/dto/create-user.dto.ts`
- `backend/src/modules/users/dto/update-user.dto.ts`

Reduce:
- `backend/src/modules/users/users.module.ts`: drop `UsersController`, `UsersService`, `AuthModule`, `ImageModule`; keep `TypeOrmModule.forFeature` entries and the `TypeOrmModule` export that remaining modules import (grep before removing `Role`, `LibraryUserAccess`), and export `UsersStatsService`.

Keep until their owner milestone: `users-stats.service.ts`, `dto/user-stats.dto.ts` (S4), `entities/user.entity.ts` + `user.entity.spec.ts` (S9, TypeORM entity for all Nest modules), `entities/media-server.entity.ts` (S5).

## Vectors/parity

No §5.2 fixture set for users. The permission predicates rely on the `acl` set (`auth.md`). Rust unit tests: the 26-field authorisation matrix (S vs M, each `403` message) and the engine-revoke condition table (`users.service.revoke.spec.ts` cases).

Parity scenarios (`server/parity/scenarios/users/`): `users-list` (admin ok; `user`, `readonly` 403), `users-get-self`, `users-get-other-as-user` (deviation `F2`, 403), `users-get-other-as-admin`, `users-get-notfound` (admin 404), `users-get-badid` (400), `users-create-ok` (library ids from role defaults), `users-create-explicit-libraries`, `users-create-conflict`, `users-create-validation`, `users-create-role-forbidden`, `users-update-self` (plan §5.3 example), `users-update-self-managed-fields` (403, message), `users-update-self-libraryids` (403 and the persisted partial write, Q2), `users-update-other-as-user` (403 bare), `users-update-admin-role-change`, `users-update-username-conflict`, `users-update-password-self` (clears `requirePasswordChange`), `users-update-share-disabled` (then GET playlists/follows owned by that user once those domains are recorded), `users-update-validation` (unknown key, bad email, short password), `users-delete` (then 404), `users-delete-forbidden`, `users-stats`, `users-stats-notfound`, `users-avatar-set`, `users-avatar-bad-mime`, `users-avatar-too-large`, `users-avatar-missing-file`, `users-avatar-clear`. Seed needs (P6): a `users.manage`-without-`roles.manage` account for `users-create-role-forbidden`, and the runner needs a multipart step for the avatar scenarios (Q8). SSE drop and engine revoke are not observable through HTTP parity (the parity engine is a stub): covered by Rust tests.

## Open questions (plan does not decide)

- Q1. Privilege escalation inside the contract: `users.manage` alone can create or update a user with `isAdmin: true` (no `roles.manage` check on `isAdmin`), reset an admin's password, enable/disable anyone including admins and itself, and delete the last admin. Keep (frozen contract) or add an F-number?
- Q2. Non-manager `PUT` with `libraryIds`: Nest persists every other field and then returns 403. Keep the partial write, or reject before writing (same status, no persisted change)?
- Q3. Any user can raise their own `movieQuotaLimit`, `seriesQuotaLimit`, `quotaPeriodDays`. Keep or make manager-only (deviation)?
- Q4. `null` for non-nullable `PUT` fields (`username`, `password`, booleans, arrays): Nest ends in a 500 or undefined behaviour. Rust: 400 (recommended, needs listing as deviation) or replicate?
- Q5. Body of the F2 403 (bare `Forbidden` assumed).
- Q6. `UsersStatsService` stays in Nest until S4 (social profile stats): accept the duplicated stats SQL in `bridge.md`'s "allowed duplication" list, or make social call Rust?
- Q7. Plan §10 S1 says delete `M/users/**` and `M/roles/**`; `user.entity.ts`, `media-server.entity.ts` and `UsersStatsService` cannot go (importers listed above). Confirm the reduced list.
- Q8. Parity runner (§5.3) only describes JSON bodies: add multipart support for the avatar scenarios?
- Q9. `DELETE /users/:id` leaves live SSE connections and the avatar files of the deleted user; keep or clean up (needs `drop-connections` and a file delete)?
