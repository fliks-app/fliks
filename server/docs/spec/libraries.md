# Spec: libraries

Scope: the `/api/libraries` routes, the library ACL helpers, the `library_user_access` table and the `library_folders` table (rules 42-47). Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); validation body = auth rule 16; `ParseIntPipe` 400 = auth rule 18; 4xx/5xx `Cache-Control: no-store` = `bootstrap.md` rule 7.

## Routes

8 routes, all in the libraries router. All require a credential (JWT or API key) and a policy; no route is stream-allowed: a `scope:'stream'` token is rejected with 401. 401 for missing/invalid credentials on every route (auth rule 14). `Library` here = the library JSON of rule 2; `Summary` = rule 5. The static segment `mine` wins over `:id` (`GET /api/libraries/mine` never reaches the integer parser).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/libraries/mine` | credential + `ability.can(Action.Read, Library)` = `media.read`, `settings.access` or `manage:all` | none | 200, `Summary[]` ordered `name ASC, id ASC` | 403 (auth rule 27) | none |
| `GET /api/libraries` | same; `ability.can(Action.Read, 'Settings')` (`settings.access` or `manage:all`) | none | 200, `Library[]` for the libraries the caller can reach (rule 3), `name ASC, id ASC`, each with `disk` and `userIds` | 403 | one `statfs` per library with a path |
| `GET /api/libraries/:id` | same; `ability.can(Action.Read, 'Settings')` | path `id` integer | 200, `Library` | 400 `Validation failed (numeric string is expected)`; 403; 404 `Library #<id> not found` (also when outside the caller's ACL, rule 40) | one `statfs` |
| `POST /api/libraries` | same; `ability.can(Action.Manage, 'Settings')` | body `CreateLibraryDto` (rule 8) | 201, `Library` (re-read after commit) | 400 validation / path errors (rules 12-14, 37); 403; constraint failures never 500 (rule 38) | INSERT `libraries`; `mkdir -p <path>`; INSERT `library_user_access` |
| `PATCH /api/libraries/:id` | same; `ability.can(Action.Manage, 'Settings')` | path `id`; body `UpdateLibraryDto` (rule 9) | 200, `Library` | 400 (validation, `ParseIntPipe`, path errors); 403; 404 `Library #<id> not found` | UPDATE `libraries`; `mkdir -p <path>` |
| `DELETE /api/libraries/:id` | same; `ability.can(Action.Manage, 'Settings')` | path `id` | 200, no body | 400 (`ParseIntPipe`); 403; 404 `Library #<id> not found` | removes every media of the library (rule 20), then the library row; files on disk kept |
| `GET /api/libraries/:id/access` | same; `ability.can(Action.Manage, 'Settings')` | path `id` | 200, `number[]` (user ids) | 400; 403; 404 `Library #<id> not found` (rule 40) | none |
| `PUT /api/libraries/:id/access` | same; `ability.can(Action.Manage, 'Settings')` | path `id`; body `{"userIds": int[]}` (rule 10) | 200, no body | 400; 403; 404 unknown library; unknown or duplicate user ids 400 (rule 38) | replace-all in a transaction; engine `revokeOwner` per removed user (rule 22) |

No route emits an SSE or domain event (Events: none).

## Rules

### A. Shape and reads

1. Policies: `Read Settings` and `Manage Settings` are both granted by `settings.access`; `Read Library` by `media.read`, `settings.access` (as `manage Library`) or `manage:all`; admins/`manage:all` satisfy everything (auth rules 20, 25).
2. `Library` JSON: `id int`, `createdAt`/`updatedAt` ISO strings, `name string` (unique), `icon string|null` (varchar 48), `color string|null` (varchar 32), `mediaTypes ('movie'|'series')[]` (jsonb, default `["movie","series"]`), `preferredProvider string|null`, `metadataLanguage string|null` (varchar 8), `metadataRegion string|null` (varchar 8), `defaultQualityProfileId int|null`, `defaultLanguageProfileId int|null` (ids only: no `defaultQualityProfile` key), `path string|null` (the path of the library's default folder, rule 42), `label string|null` (always `null`), plus `userIds int[]` and `disk`. `disk` = `null` when `path` is null, else `{freeSpace: number, totalSpace: number, accessible: bool}`; `statfs` failure (any error) = `{freeSpace: -1, totalSpace: -1, accessible: false}`. `path` and `disk` are serialised only for callers who can manage libraries (rule 41).
3. `GET /libraries` scope: ids = `accessible_library_ids(caller)` (rule 30); `[]` gives an empty result; then `ORDER BY name COLLATE "C", id ASC` (byte order, like `/api/settings`).
4. `GET /libraries/:id` and `GET /libraries/:id/access` apply the library ACL (rule 40).
5. `GET /libraries/mine` `Summary` = exactly `{id, name, icon, color, mediaTypes, defaultQualityProfileId, defaultLanguageProfileId}` (no dates, `path`, `label`, `disk`, `userIds`; the two profile ids are `int|null`), scoped like rule 3, `ORDER BY name COLLATE "C", id ASC`. Any authenticated user with `media.read` (the sidebar).
6. `statfs` semantics (Linux `statvfs`, run off the async runtime so a slow mount does not stall requests): `freeSpace = f_bfree * f_bsize` (free blocks including root-reserved, NOT `f_bavail`), `totalSpace = f_blocks * f_bsize`; JSON numbers; `accessible = (freeSpace !== -1)`.
7. `userIds` of a library = `library_user_access.userId` of that library, `ORDER BY lua.id` (insertion order, same reasoning as `users.md` rule 3). Admins appear only if they hold a row.

### B. Create and update (writes disk)

8. `CreateLibraryDto`: `name` string (required, empty string allowed, unique); optional (`IsOptional` = absent or `null` passes): `icon` string|null, `color` string|null, `mediaTypes` array of `'movie'|'series'` (`[]` allowed), `preferredProvider` string|null, `metadataLanguage` string|null, `metadataRegion` string|null, `defaultQualityProfileId` int|null, `defaultLanguageProfileId` int|null, `path` string, `userIds` int[]. Unknown keys 400 (auth rule 16).
9. `UpdateLibraryDto`: same fields minus `userIds`, all optional, `path` included. Unknown keys (`userIds` too) 400. `null` for `name`/`mediaTypes` is a 400 (rule 38).
10. `AssignLibraryAccessDto`: `userIds` required int array (`[]` allowed).
11. `create`, in ONE transaction: INSERT the row with `name`, `icon ?? null`, `color ?? null`, `mediaTypes ?? ['movie','series']`, `preferredProvider ?? null`, `metadataLanguage || null`, `metadataRegion || null` (empty string stores `null`), `defaultQualityProfileId`/`defaultLanguageProfileId` = id when truthy else `null` (so `0` and `null` both store `null`); then `assignPath` if `dto.path` is truthy (rule 13); then `replaceUserAccess` if `dto.userIds` is non-empty (rule 21); commit; then respond with `findOne(id)` read after commit (rule 2).
12. `update`, in ONE transaction: library missing → 404 `Library #<id> not found`; build a patch from the fields that are `!== undefined` (`name`, `icon`, `color`, `mediaTypes`, `preferredProvider` as given, `null` stays `null`; `metadataLanguage`/`metadataRegion` `|| null`; profile ids truthy-or-`null`); `UPDATE libraries SET <patch>, "updatedAt" = now()` only when the patch is non-empty; then `assignPath` when `dto.path !== undefined`; respond `findOne(id)` after commit. An update that changes nothing writes nothing and does not bump `updatedAt`.
13. `assignPath(libraryId, rawPath)` (the only code that touches the disk) sets the library's one folder (rule 42). Steps run in the order 1, 2, 3, 4, 6, 7, 5, 8 (numbers below are stable names, see rule 37):
    1. library row re-read inside the tx, missing → 404 `Library #<id> not found`;
    2. `trimmed = sanitizeFsPath(rawPath)`: remove code points U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF, then `trim()` (JS whitespace trim); a non-empty result that is not absolute for the platform (`Path::is_absolute`: `/data` on Unix, `D:\Films` on Windows) is a 400 (rule 37); the absolute result is normalised lexically (separators, `.` and `..` collapsed, no trailing separator, except a root) and stored as normalised (rule 46);
    3. `trimmed === ''` (empty or whitespace-only): current `path` null → no-op; else `SELECT count(*) FROM media WHERE "libraryId" = $1` > 0 → 400 `Path "<current>" still contains <n> media item(s).`; else `DELETE FROM library_folders WHERE "libraryId" = $1` and `UPDATE libraries SET "updatedAt" = now()`; done (nothing on disk);
    4. the normalised path equals the folder's current `path` → no-op, nothing checked on disk (not even existence);
    5. path does not exist (a file counts as existing, a dangling symlink does not) → `mkdir -p <trimmed>` (default mode `0o777` & umask, intermediate directories created); failure → 400 `Path "<trimmed>" could not be created on the server: <os error message>` (free text);
    6. a folder of another library is the same directory (rule 46) → 400 `Path "<trimmed>" is already attached to another library`; the `UNIQUE (path)` index turns a lost race into the same 400;
    7. current `path` non-null and different, and the library has media → 400 `Path "<current>" still contains <n> media item(s) — cannot change the library's root path.`;
    8. the folder row is updated (`library_folders.path`) or, for a library without one, inserted at `position` 0; then `UPDATE libraries SET "updatedAt" = now()`.
    The stored path is the lexically normalised input, never the realpath; there is no directory or root check.
14. Disk side effects are not transactional: `mkdir -p` (step 5) is the last step before the UPDATE, so a request rejected by a validation, conflict or in-use check leaves no directory behind; a later failure (create: `replaceUserAccess` fails) rolls the database back but leaves the newly created directories on disk. The `mkdir` is the only write: no file is created, moved or deleted, real media is never touched.
15. The path write is exercised only on temp dirs under `/tmp/fliks-parity/`; a unit test asserts `assignPath` never creates anything for the no-op/clear branches (rule 13.3, 13.4).
16. `name` uniqueness and the profile/user foreign keys are enforced by the database; the handlers map a duplicate `name`, an unknown profile id, an over-long `icon`/`color`/`metadataLanguage`/`metadataRegion`, or `null` for a NOT NULL column to a client error (rule 38).
17. The library row's FK `defaultQualityProfileId`/`defaultLanguageProfileId` are `ON DELETE SET NULL`; `library_user_access.libraryId` is `ON DELETE CASCADE`.

### C. Delete

Rules 18-20 are implemented in `media/write/delete.rs` (`media-write.md` rules 75-76).

18. `DELETE /libraries/:id`: library missing → 404 `Library #<id> not found`; list the library's media ids (`SELECT id FROM media WHERE "libraryId" = $1 ORDER BY id`); for each, sequentially, remove the media (rule 20); then delete the library row (cascade removes its `library_user_access` rows); log `Library #<id> deleted - <n> media row(s) removed, files kept`; 200 empty body.
19. Not transactional: a failure on the k-th media leaves the first k-1 removed and the library in place. Files and folders are kept.
20. Removing a media (`media-write.md`): loads the media with files, runs the request-lifecycle `onMediaRemoved` hook, `DELETE FROM media` (FK cascades), fire-and-forget thumbnail deletion per file, domain event `media.removed {mediaId, externalIds, mediaType}`, fire-and-forget `mediaServers.dispatch('media.deleted', {title, path})`.

### D. Access assignment

21. `replaceUserAccess(libraryId, userIds)` (inside a transaction): `DELETE FROM library_user_access WHERE "libraryId" = $1`; when `userIds` is non-empty, bulk INSERT one row per id (`userId`, `libraryId`). Only this library's rows are deleted (other libraries of the same users are untouched). Duplicate ids in the body or an unknown user id are a 400 (rule 38).
22. `PUT /libraries/:id/access` (`setUserAccess`): the library must exist, else 404 `Library #<id> not found` (also for `userIds: []`); `before` = current `userId`s of the library read OUTSIDE the transaction; run rule 21 in one transaction; after commit, for each id in `before` that is not in `userIds` call the engine revoke fire-and-forget (never awaited, never changes the response, no-op when the engine client is absent or lacks the `revoke` feature, failures logged as warnings). Users newly added or kept are NOT revoked. Revocation does not run on library delete (rule 18) or on `create`.
23. The revoke is the minimal engine client called directly (same as `users.md` rules 26-27): `POST /v1/revoke {"ownerId": "<userId>"}`. Library ACL is read live from the database on every request (rule 31), so no cache invalidation or SSE drop is needed after an access change.
24. `library_user_access` is also written by `users.md` (create user, `PUT /users/:id libraryIds`) and read by `sse-audience` (events-hub); the table is owned here.

### E. Library ACL helpers (used by many modules)

30. `accessible_library_ids(user)`: when `user.isAdmin` or `user.permissions` contains `manage:all` (auth rule 19: `isAdmin` implies it) return every `libraries.id` (`SELECT id FROM libraries`, unordered, resolved at call time so a new library is visible immediately); otherwise the `libraryId` of every `library_user_access` row of `user.id` (unordered; callers only test membership or use `ANY`). The result is always a concrete array; `[]` = no access and every caller short-circuits to an empty result before further SQL. Role `defaultLibraryIds` (`role_default_libraries`) are applied once, at user creation, and play no part here; `enabled` is checked by the extractor, not here.
31. The ACL is read live from the database with no cache; re-verify when adding any cache.
32. `assert_media_accessible(media_id, user)` runs `SELECT m."libraryId" AS "libraryId" FROM media m WHERE m.id = $1`: no row, or `libraryId IS NULL`, or `libraryId` not in the ids → 404 `Media #<id> not found` (the same body for "missing" and "denied": no existence leak; admins also get 404 for a media with a null library).
33. Consumers of `accessible_library_ids` / `assert_media_accessible`: the per-media guard of the media read and write routes; the media list, recently-added, counts, qualities, genres, collections, calendar and related read routes; counts by library; the playback-state and history read routes; streaming `resolveFile` (`engine-glue.md` rule 41, `playback-info.md` rule 38); playlist reads; social and likes; request listing and auto-approval; the plugin `libraryAccessible` / `mediaAccessible` object guards. `sse-audience` does not call the helper: it re-implements it (`hasEveryLibrary` = `isAdmin || manage:all`; `library_user_access` read for one library). Import-side helpers `resolveSoleLibrary`, `requirePathFor`, `resolveTargetLibrary` and `findAccepting` serve media import, requests, disk import and the Radarr/Sonarr importers.
34. One shared function `accessible_library_ids(db, &AuthUser) -> Vec<i32>` implements rule 30 from the extractor's `AuthUser` (its permission set already includes `manage:all` for `isAdmin`), and one `assert_media_accessible(db, media_id, &[i32])` implements rule 32 (404 `Media #<id> not found`, `{"message":"Media #<id> not found","error":"Not Found","statusCode":404}`). Every media read route takes the ids once per request, short-circuits on `[]`, and passes the slice into its SQL as `"libraryId" = ANY($n)` (never `IN (-1)`); per-media routes call `assert_media_accessible` before any other lookup. `playback-state.md`/`playback-info.md`/`engine-glue.md` cite "the libraries spec" for this helper: it is the one function, defined once. The table name is `library_user_access`.
35. The ACL is pinned by a parity matrix: for each of `admin`, `user` (two libraries), `readonly` (one library), `other`, call a library-scoped read route and a per-media route; ids and 404 bodies are asserted (scenarios in Vectors/parity). The `acl` fixture set covers the permission side only (`manage:all` derivation), not this function.
36. The ACL rule (rules 30-32) lives in this one place; every consumer of rule 33 calls it rather than restating it.

### F. Hardening

37. A library `path` (create, update) must be absolute for the platform (after `sanitizeFsPath`), else 400 (standard validation body, message free text). Order in `assignPath`: 1-4 as rule 13, then conflict (13.6), in-use (13.7), then `mkdir -p` (13.5), then `UPDATE` (13.8): `mkdir -p` is the last step before the UPDATE, so a rejected request leaves no directory behind.
38. No 500 on input the DTO lets through: unknown `defaultQualityProfileId`/`defaultLanguageProfileId`, unknown or duplicate `userIds`, over-length `icon` (48) / `color` (32) / `metadataLanguage` / `metadataRegion` (8), `name: null` / `mediaTypes: null` on update, non-integer or out-of-range `:id` → 400 with the standard validation body; an unknown library on `GET`/`PUT /:id/access` → 404 `Library #<id> not found`; `PUT access` runs in one transaction. A duplicate `name` on create/update is 409 `Library name already taken`, like users.
39. Every list ends with `id ASC` as final tie-break (rules 3, 5; `userIds` rule 7).
40. The library ACL (`accessible_library_ids`, rule 30) applies to `GET /api/libraries/:id` and `GET /api/libraries/:id/access`: a caller whose accessible ids do not contain `:id` gets 404 `Library #<id> not found` (same body as a missing library; admin and `manage:all` see every id).
41. `path` and `disk` of a `Library` are serialised only for callers who can manage libraries (`libraries::paths_visible`); every route of this spec already requires `settings.access`/`manage:all`, so they are always present here. No other route embeds a library row (the tracking route returns none).

### G. Folders

42. `library_folders` (`id`, `createdAt`, `updatedAt`, `libraryId` FK `ON DELETE CASCADE`, `path text` not empty, `position int >= 0`, `UNIQUE (path)`) holds a library's root folders; a library has zero or one folder, kept so by `assignPath`. The default folder is the first by `position`, then `id` (view `library_default_folders`: `libraryId`, `folderId`, `path`); every reader of "the library path" reads it there. A library with no folder is the library without a path of rules 13 and 37.
43. A media file lives in a folder: `media_files."folderId"` (`NOT NULL`, FK `ON DELETE RESTRICT`: a folder holding a file is never deleted) and `"relativePath"` relative to that folder's root (`ingest.md` rule 1), `UNIQUE ("folderId", "relativePath")`: one file on disk is one row; a `CHECK` keeps `relativePath` non-empty and free of a leading `/`, a `.` or `..` segment and an empty segment (`//`), so a file never leaves its folder root; a backslash is allowed, readers read it as `/`. A sidecar's `subtitle_files."filePath"` is relative to the same root. The absolute path of a file is `join(folder.path, relativePath)`, computed by one helper (`fsx::locate`) shared by every reader.
44. `wants."folderId"` (nullable, FK `ON DELETE SET NULL`) names the folder a want targets; NULL is the library's default folder, so a media moved to another library follows it. The migration leaves every want NULL; no route writes it.
45. Two migrations carry the move. The preflight `1789000000015` runs before every other 6.0.0 migration, on the data as 5.x left it, so a refusal commits nothing and 5.x still runs. It stores library paths normalised as `assignPath` does (doubled slashes collapsed, trailing slash dropped, except for the root) and puts a media that owns files but has no library into the one library that takes its type and has a path. `1789000000195` moves each non-empty `libraries.path` into a folder, prefixes every file's `relativePath` and every relative sidecar `filePath` (trimmed like the readers, JS `trim()`) with `<folderName>/`, turns an absolute `relativePath` under the library path into a path relative to it, sets `folderId`, and drops `libraries.path` and `libraries.label`. Neither deletes a row. The preflight raises an error that lists the ids (the first 100: re-run until clean) and the SQL that fixes them, instead of guessing, when a media file belongs to no media (re-attach it, or delete it: the delete cascades to its `playback_states` and `subtitle_files`); when several libraries name one normalised path (one `UPDATE libraries SET path` per library); when a media owns files, has no library and no single library takes it; when a library holds files but has no path (one `UPDATE` per library); when a media's `folderName` is absolute or holds a `.`, `..` or empty segment; when a file's `relativePath` is empty, outside its library or breaks the shape check of rule 43; or when two files would share one `(folder, relativePath)` (each higher id is listed with its media and the lower id it duplicates, with the `UPDATE`s re-pointing its `playback_states` and `subtitle_files` to the kept file before the `DELETE`; files on disk are untouched). So `1789000000195` cannot fail once the preflight has passed. Each message says the server cannot start until the rows are fixed with `psql`.
46. A folder path is compared by the directory it names: equal after `realpath` of the deepest existing ancestor plus the missing tail, case-insensitively on Windows and macOS, or the same device and inode on Unix. Symlinked paths and case variants of one directory are one folder; the input stays as the admin typed it, normalised lexically. At boot every pair of folders of different libraries is compared this way and a pair naming one directory is logged as a warning naming both libraries; nothing is changed. The check runs in the background (60 s limit) and never delays startup.
47. Wire: `path`, `label` and `disk` keep their shape (rules 2, 41): `path` and `disk` are the default folder's. The `Media` JSON `library.path` and `path` (`media-query.md` rule 30) read the default folder too. A file's `relativePath` is relative to its folder root (rule 43).

## SQL

Tables `libraries`, `library_folders`, the view `library_default_folders`, `library_user_access` (`"userId"`, `"libraryId"`, unique pair, FK cascade), `media` (`"libraryId"`).

- ACL ids, admin: `SELECT id FROM libraries`. Non-admin: `SELECT lua."libraryId" AS "libraryId" FROM library_user_access lua WHERE lua."userId" = $1`.
- Media gate: `SELECT m."libraryId" AS "libraryId" FROM media m WHERE m.id = $1`.
- List: `SELECT l.*, df.path FROM libraries l LEFT JOIN library_default_folders df ON df."libraryId" = l.id WHERE l.id = ANY($1) ORDER BY l.name COLLATE "C", l.id ASC` (`[]` gives an empty result); then per library `SELECT lua."userId" AS "userId" FROM library_user_access lua WHERE lua."libraryId" = $1 ORDER BY lua.id` (rule 7). `l.*` includes `"defaultQualityProfileId"`, `"defaultLanguageProfileId"`.
- Summary: `SELECT l.id, l.name, l.icon, l.color, l."mediaTypes", l."defaultQualityProfileId", l."defaultLanguageProfileId" FROM libraries l WHERE l.id = ANY($1) ORDER BY l.name COLLATE "C", l.id ASC`.
- One: the list query for one id.
- Create: `INSERT INTO libraries (name, icon, color, "mediaTypes", "preferredProvider", "metadataLanguage", "metadataRegion", "defaultQualityProfileId", "defaultLanguageProfileId") VALUES (...) RETURNING id, "createdAt", "updatedAt"`.
- Update: `UPDATE libraries SET <patched columns>, "updatedAt" = now() WHERE id = $1` (only when the patch is non-empty).
- Path: `SELECT path FROM library_default_folders WHERE "libraryId" = $1`; `SELECT count(*) FROM media WHERE "libraryId" = $1`; `SELECT "libraryId", path FROM library_folders WHERE "libraryId" <> $1`; `INSERT INTO library_folders ("libraryId", path)` or `UPDATE library_folders SET path = $2 WHERE "libraryId" = $1`, or `DELETE FROM library_folders WHERE "libraryId" = $1` when cleared; `UPDATE libraries SET "updatedAt" = now() WHERE id = $1`.
- Access: `DELETE FROM library_user_access WHERE "libraryId" = $1`; `INSERT INTO library_user_access ("libraryId", "userId") VALUES ($1,$2),...`.
- Delete: `SELECT m.id FROM media m WHERE m."libraryId" = $1 ORDER BY m.id`; then remove each media (rule 20); `DELETE FROM libraries WHERE id = $1`.

## Events

none. No library route emits an SSE or domain event. `media.removed` is emitted per media when a library is deleted (rule 20; owned by the media domain, hub in events-hub.md). The ACL helper is consumed by `sse-audience` only through its own copy (rule 33).

## Settings keys

none.

## Jobs/timers

none.

## Vectors/parity

No fixture set (the ACL function is two SQL reads; permissions are in the `acl` set, `auth.md`). Rust tests: path state machine (rule 13 steps 1-8 on a temp dir: create, no-op, clear, conflict, media-in-use, `mkdir` failure on a read-only parent; relative path 400 and conflict/in-use leave no directory, rule 37), `sanitizeFsPath` cases (U+202A prefix, zero-width, whitespace-only), `statfs` field arithmetic (rule 6), the access-revoke diff (rule 22: kept and added users not revoked), ACL ids for admin / `manage:all` / role without library rows.

Parity scenarios (`server/parity/scenarios/libraries/`): `mine` (admin, `user`, `readonly`; shape of rule 5), `list-admin`, `list-user-scoped` (a `settings.access` non-admin sees only its libraries), `list-forbidden` (`user` without `settings.access` 403, anon 401), `get`, `get-notfound` (404), `get-badid` (400), `get-outside-acl` (404, rule 40), `create-ok` (201, `disk` for a `/tmp/fliks-parity/` path, directory exists afterwards), `create-mkdir-nested` (rule 13.5), `create-path-conflict` (400, no directory left behind), `create-relative-path` (400), `create-validation` (400), `create-duplicate-name` (409), `update-name`, `update-path-change-with-media` (400), `update-path-clear`, `update-path-clear-with-media` (400), `update-notfound`, `update-null-name` (400), `access-get`, `access-set` (200 then GET), `access-set-unknown-user` (400), `access-get-unknown` (404), `access-set-forbidden`, `delete` and `delete-notfound`, and the ACL matrix of rule 35: `acl-media-list-{admin,user,readonly}`, `acl-media-get-{denied-as-404,null-library-as-admin}` (run through the media routes). Engine revoke is checked by a Rust unit test against a stub engine (no parity step can observe it). Every 403/401 step asserts `statusCode` and `error`.

## Open questions

none.
