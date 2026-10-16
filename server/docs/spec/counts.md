# Spec: counts

Sources: `[ts:src/modules/counts/counts.controller.ts]`, `[ts:src/modules/counts/counts.service.ts]`, `[ts:src/modules/counts/counts.module.ts]`, `[ts:src/modules/plugins/host/plugin-counts-cache.service.ts]` (read side only), `[ts:src/modules/counts/counts.service.spec.ts]`. Milestone: S8 (plan §10). Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N"). Tag paths are relative to `backend/`.

One route, three independent counters computed in one round trip for the app shell sidebar. Until S8 Nest serves it (the Rust router has no `/api/counts`; the fallback forwards it), because `badgeCounts` reads the in-memory plugin push cache that only plugin code fills (rule 12).

## Routes

Manifest filter `.[]|select(.path=="/api/counts")` = 1 route `[ts:src/modules/counts/counts.controller.ts:17]`.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/counts` | `JwtOrApiKeyGuard` only (no `PoliciesGuard`, `policies: ""` in the manifest): any authenticated enabled user; Rust `Authed` (F8: a scoped stream token is 401) | none (no query, no body; unknown query keys ignored: no DTO) | 200 `{ badgeCounts: { [key: string]: number }, pendingRequests: int, mediaByLibrary: { [libraryId: string]: int } }` (rule 1) | 401 (auth rule 14) | none |

No 403 exists: each counter applies its own ability check inside the service and degrades to an empty value (rules 5-9). No route emits an SSE or domain event.

## Rules

### A. Shape

1. Response is always the three keys, none ever `null`: `badgeCounts` (object, possibly `{}`), `pendingRequests` (integer, `0` when nothing), `mediaByLibrary` (object, possibly `{}`). Key order in JSON: `badgeCounts`, `pendingRequests`, `mediaByLibrary`. `[ts:src/modules/counts/counts.service.ts:17]`-`[ts:src/modules/counts/counts.service.ts:23]`, `[ts:src/modules/counts/counts.service.ts:45]`-`[ts:src/modules/counts/counts.service.ts:49]`
2. Null vs absent: a `badgeCounts` key that no publisher pushed, or that the caller may not see, is ABSENT, never present-and-0 (the client folds `pendingRequests` into the same map and shows a badge only for a truthy value). `mediaByLibrary` omits libraries without media. `[ts:src/modules/counts/counts.service.ts:18]`-`[ts:src/modules/counts/counts.service.ts:19]`, `[ts:src/modules/counts/counts.service.spec.ts:40]`-`[ts:src/modules/counts/counts.service.spec.ts:62]`
3. The ability is built once per request (`createForUser(user)`), then the two SQL counters run concurrently (`Promise.all`); `badgeCounts` is a synchronous in-memory read. Any DB error rejects the whole call (500), there is no per-counter fallback. Rust: same, errors propagate as 500. `[ts:src/modules/counts/counts.service.ts:39]`-`[ts:src/modules/counts/counts.service.ts:50]`
4. No cache of any kind on the SQL counters: every call re-queries. `[assumed]`: nothing in `counts.service.ts` memoises (the client refetches on SSE count-bearing events, `layout.ts`). `[ts:src/modules/counts/counts.service.ts:39]`

### B. `pendingRequests`

5. Scope: `ability.can(Action.Manage, FliksRequest)` = permission `requests.manage` or `manage:all`: counts every request with `status = 'pending'`; otherwise only the caller's own (`userId = user.id`). The check is class-level (auth rule 26: any rule of that action on the subject), `requests.create` alone grants `create/read/update/delete` with conditions but NOT `manage`, so a plain requester gets the own-scope branch. `[ts:src/modules/counts/counts.service.ts:68]`-`[ts:src/modules/counts/counts.service.ts:81]`, `[ts:src/modules/auth/casl/casl-ability.factory.ts:120]`-`[ts:src/modules/auth/casl/casl-ability.factory.ts:122]`
6. No permission is needed for the own-scope count: a user with neither `requests.create` nor `requests.manage` still gets the count of their own pending requests (normally 0; non-zero after losing the permission). Not a leak: own rows only. `[ts:src/modules/counts/counts.service.ts:72]`-`[ts:src/modules/counts/counts.service.ts:79]`
7. The own-scope filter goes through the relation (`user: { id }`), because `userId` is a `@RelationId`, not a queryable column; Rust filters the real column `"userId"`. A request with `userId IS NULL` (column is nullable in the schema, FK is `ON DELETE CASCADE` so none arise in practice) counts only for managers. `[ts:src/modules/counts/counts.service.ts:73]`-`[ts:src/modules/counts/counts.service.ts:78]`, `[ts:src/modules/requests/entities/request.entity.ts:21]`-`[ts:src/modules/requests/entities/request.entity.ts:25]`

### C. `mediaByLibrary`

8. Gate: `ability.can(Action.Read, Media)` = `media.read` or `manage:all`; otherwise `{}` and NO query and NO library-id lookup (the unit test pins both). `[ts:src/modules/counts/counts.service.ts:89]`, `[ts:src/modules/auth/casl/casl-ability.factory.ts:84]`-`[ts:src/modules/auth/casl/casl-ability.factory.ts:85]`, `[ts:src/modules/counts/counts.service.spec.ts:89]`-`[ts:src/modules/counts/counts.service.spec.ts:98]`
9. Scope: `getAccessibleLibraryIds(user)` (`libraries.md` rule 30: every library for `isAdmin`/`manage:all`, else the user's `library_user_access` rows), passed to `getCountsByLibrary` = the same query as `GET /api/media/counts-by-library` (`media-query.md` rule 36): `[]` → `{}` (`1 = 0`); only `libraryId IS NOT NULL` media; `COUNT(*)::int` per library; object keyed by the library id as a string, ascending numeric key order (JS integer-key order), libraries without media absent. Media of a library the caller cannot reach never appears: no leak (no F row). `[ts:src/modules/counts/counts.service.ts:85]`-`[ts:src/modules/counts/counts.service.ts:93]`, `[ts:src/modules/media/media-service/media-query.service.ts:123]`-`[ts:src/modules/media/media-service/media-query.service.ts:135]`, `[ts:src/modules/media/media-service/media-query.service.ts:990]`-`[ts:src/modules/media/media-service/media-query.service.ts:1002]`
10. A caller with `settings.access` but without `media.read` gets `{}` here while `GET /api/libraries` lists libraries to them: intended gating, kept. `[ts:src/modules/counts/counts.service.ts:83]`-`[ts:src/modules/counts/counts.service.ts:84]`
11. Rust at S8 calls the Rust function ported in S3 (`counts_by_library(db, &ids)` behind `GET /api/media/counts-by-library`, and `accessible_library_ids`, `libraries.md` rule 34): no new SQL. `[new]` (porting rule, plan §0.2)

### D. `badgeCounts`

12. Only one key is ever served: `queueActive`. It is present only when BOTH (a) the caller `can(Manage, 'Settings')` (`settings.access`/`manage:all`) or `can(Track, Media)` (`media.create`, `requests.create` or `manage:all`: the users the client seeds queue progress for) AND (b) some running plugin pushed it (`counts.set`). Otherwise absent. Any other key a plugin pushes is stored but never served. `[ts:src/modules/counts/counts.service.ts:55]`-`[ts:src/modules/counts/counts.service.ts:64]`, `[ts:src/modules/auth/casl/casl-ability.factory.ts:102]`-`[ts:src/modules/auth/casl/casl-ability.factory.ts:105]`
13. Source: `PluginCountsCacheService`, an in-memory `Map<pluginId, Map<key, number>>`; `get(key)` SUMS the value across plugins that pushed it, `has(key)` is true when any pushed it (an explicit `0` is present: `queueActive: 0`). Not persisted: a restart empties it until the plugin reconnects and re-pushes. `forget(pluginId)` runs on plugin unregister, so a stopped plugin stops contributing (and `queueActive` goes absent when it was the only publisher). `[ts:src/modules/plugins/host/plugin-counts-cache.service.ts:14]`-`[ts:src/modules/plugins/host/plugin-counts-cache.service.ts:39]`, `[ts:src/modules/plugins/plugin-registry.service.ts:400]`
14. Writer: host method `counts.set {key, value}` (scope `events:emit`), no validation of `key` or `value`: `value` may be `NaN`/negative/fractional; `JSON.stringify` of `NaN` is `null`, which would violate rule 1 (C?b). A call outside a plugin context (no current plugin id) is silently dropped. `[ts:src/modules/plugins/host/fliks-host.service.ts:1056]`-`[ts:src/modules/plugins/host/fliks-host.service.ts:1060]`, `[ts:src/common/plugin-contract/host-methods.ts:257]`-`[ts:src/common/plugin-contract/host-methods.ts:258]`, `[ts:src/common/plugin-contract/principal.ts:46]`
15. Rust: the cache moves with the plugin host (plugin design doc, plan §8); `/api/counts` reads it through one in-process function (`has`/`get`/`forget`), same sum and absent-vs-0 semantics. A Rust restart empties it exactly as Nest's restart does. `[new]`

## SQL

All reads; Rust forms. `$1 = user.id`, `$2 = accessible library ids`.

- Pending, manager (rule 5): `SELECT count(*)::int FROM requests WHERE status = 'pending'`.
- Pending, own: `SELECT count(*)::int FROM requests WHERE status = 'pending' AND "userId" = $1`. Nest's TypeORM `count` with the relation filter `[assumed]` emits `COUNT(1) ... LEFT JOIN users ... WHERE status = 'pending' AND users.id = $1`; same result because of the FK.
- Media per library (rule 9), only when `media.read` and `$2` is non-empty: `SELECT m."libraryId", COUNT(*)::int FROM media m WHERE m."libraryId" IS NOT NULL AND m."libraryId" = ANY($2) GROUP BY m."libraryId"` (no `ORDER BY`; Rust sorts the keys numerically when building the object).
- Accessible ids (`libraries.md` rule 30): `SELECT id FROM libraries` (admin) or `SELECT "libraryId" FROM library_user_access WHERE "userId" = $1`.

## Events

None emitted or consumed. The client refreshes on its own triggers; no SSE carries counts.

## Settings keys

None.

## Jobs/timers

None.

## Bridges

No endpoint. Dependencies, and the milestone after which the Rust port calls Rust code (everything below is Rust by S8 except the plugin cache):

| Nest dependency | Used for | Rust home | Moves at |
|---|---|---|---|
| `CaslAbilityFactory.createForUser` (`counts.service.ts:40`) | rules 5, 8, 12 | `fliks_domain::acl` + `AuthUser` permission set | S1 |
| `LibrariesService.getAccessibleLibraryIds` | rule 9 | `accessible_library_ids` (`libraries.md` rule 34) | S3 |
| `MediaService.getCountsByLibrary` -> `MediaQueryService` | rule 9 | `counts_by_library` of the S3 media-query port | S3 |
| `requests` table (`FliksRequest` repo) | rules 5-7 | requests domain (table read only; no service) | S5 (DDL: S0) |
| `PluginCountsCacheService` (+ `PluginCountsCacheModule`) | rules 12-15 | plugin host cache | S8: exists only in plugin code, no earlier Rust home |
| `counts.set` host method (`fliks-host.service.ts`) | writer of the cache | plugin host | S8 (plugin code) |

Allowed duplication (listed in `bridge.md` "Allowed duplication", not an endpoint): "library ACL verify in Nest" runs S3 to S8, not S5 as `libraries.md` rules 33-36 and `media-query.md` Q4 state (plan §15.3 decided S8): Nest `getAccessibleLibraryIds`, `assertAccessible` and `getCountsByLibrary` are read queries on the shared database and stay until this milestone deletes them. S5 must therefore keep those three (and `applyLibraryAcl`) when it deletes `M/media/**` and `M/libraries/**`.

No new bridge is proposed. Known gap until S8: the plugin cache lives only in Nest's plugin host, so `/api/counts` stays a Nest route until S8 (the Rust fallback forwards it); nothing Rust-side reads `queueActive` before then. If S5 deletes `getCountsByLibrary`/`getAccessibleLibraryIds` anyway (instead of keeping them per plan §15.3), `mediaByLibrary` stays broken until S8: acceptable under the no-release-before-S9 decision, but record it in the S5 PR.

## Deletes in Nest

Milestone S8 (plan §10 S8 "Deletes from Nest").

- `backend/src/modules/counts/**`: `counts.controller.ts`, `counts.service.ts`, `counts.service.spec.ts`, `counts.module.ts`; remove `CountsModule` from `src/app.module.ts:27,82` imports; remove `/api/counts` from `server/contract/nest-routes.json`.
- Leftovers kept alive only for this module and `plugin-object-guards.service.ts` (both gone at S8): `MediaQueryService.getCountsByLibrary` + `applyLibraryAcl` + `assertAccessible` (`media-query.service.ts:123`-`:135`, `:585`-`:603`, `:990`-`:1002`), `MediaService.getCountsByLibrary` / `assertAccessible` delegates, `LibrariesService.getAccessibleLibraryIds` (`libraries.service.ts:63`); with them the remainder of `M/media/**` and `M/libraries/**` the S5 spec left (re-grep importers first), and the `bridge.md` duplication row.
- `PluginCountsCacheService`/`PluginCountsCacheModule` go with `M/plugins/**`.
- Client: no change (`/api/counts` path and body are frozen).

## Vectors/parity

No §5.2 fixture set (no pure logic beyond the permission derivation in the `acl` set). Rust tests: `#[sqlx::test]` for rules 5-9 (manager vs own scope, userless request, `[]` ids, library without media absent, numeric key order with ids 2 and 10); unit tests for the cache (sum across plugins, `has` after explicit 0, `forget`) and rule 12's ability gate (`media.create`-only, `requests.create`-only, `settings.access`-only, none).

Parity scenarios (`server/parity/scenarios/counts/`, recorded against Nest, plan §5.3): `counts-admin`, `counts-user` (2 libraries, own pending), `counts-readonly` (1 library), `counts-noread` (`mediaByLibrary: {}`), `counts-manager-pending` (requests manager sees all pending), `counts-unauthenticated` (401), `counts-stream-token` (deviation F8: 401, Nest 200). `badgeCounts` is `{}` in parity (no plugin running); the present case is a Rust unit test. Compare `mediaByLibrary` keys unordered only if numeric order cannot be asserted by the runner; ids 2 and 10 in the seed pin it.

## Open questions

- Security: none. Checked: `mediaByLibrary` and its keys are scoped to accessible libraries (rule 9), `pendingRequests` to own rows (rules 5-6), `queueActive` to queue audiences (rule 12); no F row proposed. The stream-token acceptance is F8 (auth rule 12), applies here without a new row.
- Correctness, proposed `C?b`: `counts.set` with a non-finite, negative or fractional `value`, or an empty/over-long `key`, is stored as is; `NaN` reaches the client as `queueActive: null` (rule 14). Rust validates in the plugin host: `value` finite integer `>= 0` else the host call errors, never stored. Belongs to the plugin design doc (plan §8); recorded here because the contract of this route depends on it.
- Q1. Rule 12: other keys pushed by a plugin are never served. Keep (frozen), or serve per the nav contribution `badge` field as the interface comment implies (`counts.service.ts:18`)? Default: keep, no client reads another key today.
- Q2. `bridge.md` "Allowed duplication" and `libraries.md` rules 33-36 / `media-query.md` Q4 say S5; plan §15.3 says S8. This spec follows §15.3; the S3/S5 porters must keep the three Nest read helpers until S8 (answers `media-query.md` Q4: counts and plugin guards are removed at S8, not re-homed).
