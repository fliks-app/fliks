# Spec: roles

CASL semantics and error bodies are in `auth.md` (cited as "auth rule N").

## Routes

6 routes. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard`; 401 on missing/invalid credentials, 403 `Forbidden resource` on a failed policy (auth rules 14, 27). `Role` JSON = rule 1. Path ids are integers (`ParseIntPipe`: non-integer 400 `Validation failed (numeric string is expected)`). `GET /roles/permissions` is declared before `:id` and must win the route match. A `stream`-scope token is answered 401 (auth rule 12).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/roles` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Read, Role)` | none | `Role[]` `ORDER BY name ASC`, each with `defaultLibraries` | 403 | none |
| `GET /api/roles/permissions` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, Role)` | none | `string[]` (rule 12) | 403 | none |
| `GET /api/roles/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Read, Role)` | path `id` | `Role` | 400; 404 `Role #<id> not found`; 403 | none |
| `POST /api/roles` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, Role)` | body `{name: string, permissions: string[], isDefault?: bool, defaultLibraryIds?: int[]}`; unknown keys 400 | 201, `Role` | 400; 409 `Role name already exists`; 403 | INSERT `roles`, `role_default_libraries`; clears other defaults |
| `PUT /api/roles/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, Role)` | path `id`; body all-optional `{name, permissions, isDefault, defaultLibraryIds}` | `Role` | 400; 404; 409 `Role name already exists`; 403 | UPDATE `roles`, join rows; clears other defaults |
| `DELETE /api/roles/:id` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `ability.can(Action.Manage, Role)` | path `id` | 200, no body | 400; 404; 409 `Cannot delete role "<name>": still assigned to <n> user(s)`; 403 | DELETE `roles`, join rows |

## Rules

1. `Role` JSON = `{id: number, createdAt: ISO, updatedAt: ISO, name: string, permissions: string[], isDefault: bool, defaultLibraries: Library[], defaultLibraryIds: number[]}`. `permissions` is a `simple-json` column: a JSON array stored as text, returned as an array. `Library` items are full `libraries` rows: `id, createdAt, updatedAt, name, icon (string|null), color (string|null), mediaTypes (('movie'|'series')[]), preferredProvider (string|null), metadataLanguage (string|null), metadataRegion (string|null), defaultQualityProfileId (number|null), defaultLanguageProfileId (number|null), path (string|null), label (string|null)` (no nested profile objects: those relations are not loaded).
2. `defaultLibraryIds` is always fresh: `POST` and `PUT` return the ids just written, and `defaultLibraries` matches. The `POST` response's `defaultLibraries` items omit `defaultQualityProfileId` and `defaultLanguageProfileId` (the freshly loaded libraries lack those columns); `PUT`, `GET` and the list carry them (scenarios `roles/create-ok`, `roles/update-libraries`).
3. Order of `defaultLibraries` and `defaultLibraryIds` inside a role: library id ascending.
4. `GET /roles`: all roles `ORDER BY name ASC` (database collation) with `defaultLibraries` joined.
5. `GET /roles/:id`: role with `defaultLibraries` else 404 `Role #<id> not found`.
6. Create order: (a) another role with the same `name` (exact) → 409 `Role name already exists`; (b) if `isDefault` is truthy, `UPDATE roles SET "isDefault" = false WHERE "isDefault" = true` (all roles); (c) `defaultLibraryIds` resolved by `WHERE id IN (...)`: unknown ids are silently dropped, empty or absent gives `[]`; (d) insert `{name, permissions, isDefault: dto.isDefault ?? false}` and join rows; respond with the saved role (rule 2). Steps are not transactional.
7. Update order: load the role (404); `name` defined AND different from the current: duplicate check against another role (409) then set; `permissions` defined: replace the whole array; `isDefault` defined: if `true` first clear the flag on every role, then set `role.isDefault` to the given value (`false` is allowed even for the current default, leaving no default role; users created afterwards then get no role, `users.md` rule 9); `defaultLibraryIds` defined: replace the join set (unknown ids dropped, `[]` clears); save; respond with the saved role (rule 2). Not transactional.
8. Delete: role missing → 404; `COUNT(*) FROM users WHERE "roleId" = id` > 0 → 409 `Cannot delete role "<name>": still assigned to <n> user(s)`; else delete the role (its `role_default_libraries` rows go with it); 200 empty body. The seeded `Admin`, `User`, `Readonly` roles have no protection: they can be edited, renamed, emptied, deleted when unused.
9. DTOs: `name` string (empty string passes); `permissions` array of strings (required on create). Strings a request adds (all of them on create; those not already on the role on update) must be in `GET /roles/permissions` (400 `permissions contains invalid values`); adding `manage:all` needs a `manage:all` caller (bare 403), and strings already on the role are resent unchecked; duplicates are accepted); `isDefault` bool; `defaultLibraryIds` int[]. All fields optional on update; unknown keys 400.
10. Role edits take effect on the user's next request (the extractor reloads the role every time, auth rule 9). No SSE drop and no engine revoke happens when a role's permissions change, unlike a user's role change (`users.md` rule 25).
11. Seeding at boot: if `roles` is empty insert, in this order, `Admin` = the 12 core permissions (all of `PERMISSIONS`, `isDefault false`), `User` = `['media.read','livetv.read','requests.create']` (`isDefault true`), `Readonly` = `['media.read','livetv.read']` (`isDefault false`). It runs after migrations, before listening. The seeded admin user has no role (`users.md` rule 7).
12. `GET /roles/permissions` = core `PERMISSIONS` in declaration order (`media.read, media.create, media.edit, media.delete, media.grab, livetv.read, requests.create, requests.manage, subtitles.manage, settings.access, users.manage, roles.manage`) followed by the plugin grants (rule 13). `manage:all` is not listed.
13. Plugin grants, read from `plugin_packages`: the rows with `enabled = true` and `status = 'active'` whose `manifest.kind = 'process'` (open question below). Nothing is granted when the env var `FLIKS_PLUGINS_DISABLED=1` (no plugin is loaded). Per plugin row: `subjects` = for each name in `manifest.permissions` the string `plugin:<pluginId>:<name>`; a name must match `^[a-z][a-z0-9_-]{0,63}$` and be unique, else the plugin fails registration and contributes nothing; a plugin with no subjects contributes nothing. For each route in `manifest.routes`: `subject = route.policy` after the first `:`; if `subject` is in `subjects`, add `route.policy` (e.g. `read:plugin:fliks.a:queue`, action-prefixed) and mark the subject covered. Then add every uncovered subject as the bare string. The union over plugins is **sorted** (UTF-16 code-unit order; ASCII-only here, so byte order is equal).
14. Granting a plugin permission to a role is shape-only (`auth.md` rule 23); plugin route authorisation re-checks the subject per plugin.
15. Policy notes: `users.manage` grants `read Role` (list, get) but not `GET /roles/permissions` nor any write; `roles.manage` (`manage Role`) matches every action including read; `manage:all` everything (auth rules 21, 25).
16. `defaultLibraries[].path` is serialised only for callers who can manage libraries (`libraries::paths_visible`); the `roles-list-manager` scenario records it for a `users.manage` caller.

## SQL

Tables `roles` (`id, "createdAt", "updatedAt", name UNIQUE, permissions text, "isDefault" bool`), `role_default_libraries` (`"roleId"`, `"libraryId"`; FK cascade on library delete), `libraries`, `users`, `plugin_packages`. Equivalent SQL:

- List: `SELECT r.*, l.* FROM roles r LEFT JOIN role_default_libraries rdl ON rdl."roleId" = r.id LEFT JOIN libraries l ON l.id = rdl."libraryId" ORDER BY r.name ASC`.
- One: same joins `WHERE r.id = $1`.
- Name check: `SELECT id FROM roles WHERE name = $1`.
- Clear default: `UPDATE roles SET "isDefault" = false, "updatedAt" = now() WHERE "isDefault" = true`.
- Libraries: `SELECT * FROM libraries WHERE id IN ($1,...)` (skipped when the list is empty or absent).
- Insert: `INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, $2::text, $3) RETURNING id, "createdAt", "updatedAt"` plus `INSERT INTO role_default_libraries ("roleId","libraryId")...`.
- Update: `UPDATE roles SET <changed>, "updatedAt" = now() WHERE id = $1`; join set replaced by deleting the unwanted rows and inserting the new ones.
- In-use count: `SELECT count(*) FROM users WHERE "roleId" = $1`; delete: `DELETE FROM role_default_libraries WHERE "roleId" = $1; DELETE FROM roles WHERE id = $1`.
- Seed: `SELECT count(*) FROM roles`, then three inserts (rule 11).
- Plugin grants (rule 13): `SELECT "pluginId", manifest FROM plugin_packages WHERE enabled = true AND status = 'active'` (`manifest` jsonb; keep only `kind = 'process'`).

## Events

none (no SSE event, no domain event).

## Settings keys

none

## Jobs/timers

none (boot-time role seed only, rule 11)

## Vectors/parity

Fixture set: none. The `acl` set (`auth.md`) covers the `Role` checks (`users.manage` reads roles, `roles.manage` manages them). Plugin-grant derivation: Rust unit tests cover route policies keeping read and manage separate and sorted, the bare subject fallback, and no declared permission giving `[]`, plus a case for a plugin row with `enabled = false`, one with `status = 'failed'`, and `FLIKS_PLUGINS_DISABLED=1`.

Parity scenarios: one file per case in `server/parity/scenarios/roles/` (`grant-manage-all-forbidden` and `permission-unknown-string` cover rule 9). The seed needs a `users.manage` account to show `read Role` without `manage Role` (403 on create and on `roles-permissions`), see `users.md`.

## Open questions

- Which plugin rows count as "registered": a plugin whose jobs, routes, i18n namespace or UI declarations fail validation is rejected by the registry, which the DB row alone does not reveal. Rule 13 uses the `enabled AND status = 'active'` approximation.
