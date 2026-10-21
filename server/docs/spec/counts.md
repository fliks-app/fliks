# Spec: counts

Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N").

One route, three independent counters computed in one round trip for the app shell sidebar. `badgeCounts` reads the in-memory plugin push cache that only plugin code fills (rule 12).

## Routes

One route.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/counts` | `Authed` only, no policy: any authenticated enabled user; a scoped stream token is 401 | none (no query, no body; unknown query keys ignored: no DTO) | 200 `{ badgeCounts: { [key: string]: number }, pendingRequests: int, mediaByLibrary: { [libraryId: string]: int } }` (rule 1) | 401 (auth rule 14) | none |

No 403 exists: each counter applies its own ability check inside the service and degrades to an empty value (rules 5-9). No route emits an SSE or domain event.

## Rules

### A. Shape

1. Response is always the three keys, none ever `null`: `badgeCounts` (object, possibly `{}`), `pendingRequests` (integer, `0` when nothing), `mediaByLibrary` (object, possibly `{}`). Key order in JSON: `badgeCounts`, `pendingRequests`, `mediaByLibrary`.
2. Null vs absent: a `badgeCounts` key that no publisher pushed, or that the caller may not see, is ABSENT, never present-and-0 (the client folds `pendingRequests` into the same map and shows a badge only for a truthy value). `mediaByLibrary` omits libraries without media.
3. The ability is built once per request , then the two SQL counters run concurrently; `badgeCounts` is a synchronous in-memory read. Any DB error rejects the whole call (500), there is no per-counter fallback.
4. No cache of any kind on the SQL counters: every call re-queries. Nothing memoises; the client refetches on SSE count-bearing events.

### B. `pendingRequests`

5. Scope: `ability.can(Action.Manage, FliksRequest)` = permission `requests.manage` or `manage:all`: counts every request with `status = 'pending'`; otherwise only the caller's own (`userId = user.id`). The check is class-level (auth rule 26: any rule of that action on the subject), `requests.create` alone grants `create/read/update/delete` with conditions but NOT `manage`, so a plain requester gets the own-scope branch.
6. No permission is needed for the own-scope count: a user with neither `requests.create` nor `requests.manage` still gets the count of their own pending requests (normally 0; non-zero after losing the permission). Not a leak: own rows only.
7. The own-scope filter is on the column `"userId"`. A request with `userId IS NULL` (column is nullable in the schema, FK is `ON DELETE CASCADE` so none arise in practice) counts only for managers.

### C. `mediaByLibrary`

8. Gate: `ability.can(Action.Read, Media)` = `media.read` or `manage:all`; otherwise `{}` and NO query and NO library-id lookup (the unit test pins both).
9. Scope: the accessible library ids of the user (`libraries.md` rule 30: every library for `isAdmin`/`manage:all`, else the user's `library_user_access` rows), passed to the counts-by-library query, the same query as `GET /api/media/counts-by-library` (`media-query.md` rule 36): `[]` → `{}` (`1 = 0`); only `libraryId IS NOT NULL` media; `COUNT(*)::int` per library; object keyed by the library id as a string, ascending numeric key order, libraries without media absent. Media of a library the caller cannot reach never appears.
10. A caller with `settings.access` but without `media.read` gets `{}` here while `GET /api/libraries` lists libraries to them: intended gating, kept.
11. The handler calls `crate::libraries::acl::accessible_library_ids(db, &authed)` and `crate::media::aggregates::counts_by_library(db, &ids)` (the `GET /api/media/counts-by-library` query, serialised by `ByLibrary` in numeric key order): no SQL of its own.

### D. `badgeCounts`

12. Only one key is ever served: `queueActive`. It is present only when BOTH (a) the caller `can(Manage, 'Settings')` (`settings.access`/`manage:all`) or `can(Track, Media)` (`media.create`, `requests.create` or `manage:all`: the users the client seeds queue progress for) AND (b) some running plugin pushed it (`counts.set`). Otherwise absent. Any other key a plugin pushes is stored but never served (no client reads another key).
13. Source: the plugin counts cache, an in-memory map of plugin id to key to number; `get(key)` SUMS the value across plugins that pushed it, `has(key)` is true when any pushed it (an explicit `0` is present: `queueActive: 0`). Not persisted: a restart empties it until the plugin reconnects and re-pushes. `forget(pluginId)` runs on plugin unregister, so a stopped plugin stops contributing (and `queueActive` goes absent when it was the only publisher).
14. Writer: host method `counts.set {key, value}` (scope `events:emit`). The plugin host validates: `value` must be a JSON integer `>= 0` (serde check) and `key` 1 to 64 characters, else the host call errors and nothing is stored. This keeps rule 1's `number` type true. A call outside a plugin context (no current plugin id) is silently dropped.
15. The cache lives in the plugin host; `/api/counts` reads it through one in-process function (`has`/`get`/`forget`), same sum and absent-vs-0 semantics. A restart empties it.

## SQL

All reads. `$1 = user.id`, `$2 = accessible library ids`.

- Pending, manager (rule 5): `SELECT count(*)::int FROM requests WHERE status = 'pending'`.
- Pending, own: `SELECT count(*)::int FROM requests WHERE status = 'pending' AND "userId" = $1`.
- Media per library (rule 9), only when `media.read`: the `counts_by_library` query, `SELECT m."libraryId", COUNT(*)::int FROM media m WHERE m."libraryId" IS NOT NULL AND m."libraryId" = ANY($2) GROUP BY m."libraryId" ORDER BY m."libraryId"` (`ORDER BY` gives the numeric key order; `$2 = []` matches nothing, so `{}`).
- Accessible ids (`libraries.md` rule 30, `accessible_library_ids`): `SELECT id FROM libraries ORDER BY id` (admin/`manage:all`) or `SELECT "libraryId" FROM library_user_access WHERE "userId" = $1 AND "libraryId" IS NOT NULL ORDER BY id`.

## Events

None emitted or consumed. The client refreshes on its own triggers; no SSE carries counts.

## Settings keys

None.

## Jobs/timers

None.

## Vectors/parity

No fixture set (no pure logic beyond the permission derivation in the `acl` set). The integration test in `server/crates/server/tests/it/settings.rs` covers the admin response shape (one library, own pending request, `badgeCounts: {}`), a plain user's `pendingRequests: 0` and the 401 without a token. The plugin counts cache has a unit test for validation and the sum across plugins (`server/crates/server/src/plugins/counts.rs`).

## Open questions

None.
