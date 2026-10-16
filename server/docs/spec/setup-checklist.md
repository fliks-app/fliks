# Spec: setup-checklist

Sources: `[ts:src/modules/setup-checklist/setup-checklist.controller.ts]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts]`, `[ts:src/modules/setup-checklist/checklist-item-registry.service.ts]`, `[ts:src/modules/setup-checklist/checklist-item-registry.module.ts]`, `[ts:src/modules/setup-checklist/setup-checklist.module.ts]`, `[ts:src/modules/settings/settings.service.ts]` (`get`/`set`). Milestone: S8 (plan §10; `setup_checklist_dismissed_keys` is owned at S8, plan §15.1). Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); settings store semantics in `settings.md`. Tag paths are relative to `backend/`.

Three routes: list the onboarding items with a computed `done` flag and a stored `dismissed` flag, dismiss, un-dismiss. Dismissal is global (one JSON array in `app_settings`), not per user.

## Routes

3 routes in the manifest (`.[]|select(.file|test("modules/setup-checklist/"))` = 3). Class-level guards `JwtOrApiKeyGuard, PoliciesGuard` `[ts:src/modules/setup-checklist/setup-checklist.controller.ts:20]`; no `SessionTokenGuard` (F8: Rust rejects a scoped stream token with 401, Nest accepted it). `Read Settings` and `Manage Settings` are both granted by `settings.access` or `manage:all` only (`libraries.md` rule 1), so the two policies are equivalent today.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/setup-checklist` | class guards; `ability.can(Action.Read, 'Settings')` | none | 200 `ChecklistItem[]` (rule 1), core items in fixed order (rule 3) | 401, 403 (auth rule 27) | none |
| `POST /api/setup-checklist/:key/dismiss` | class guards; `ability.can(Action.Manage, 'Settings')` | path `key` string (any string, URL-decoded); body ignored (no DTO: `{}`, empty, or extra keys all pass) | **201** (Nest default for `@Post`, no `@HttpCode`) `{ "ok": true }` | 400 `{"message":"Unknown checklist key: <key>","error":"Bad Request","statusCode":400}`; 401; 403 | read-modify-write of `app_settings.setup_checklist_dismissed_keys` unless already dismissed (rule 14) |
| `DELETE /api/setup-checklist/:key/dismiss` | same, `Manage Settings` | path `key` | 200 `{ "ok": true }` | 400 as above (the key must be KNOWN, even to un-dismiss); 401; 403 | same, unless not dismissed (rule 15) |

Controller lines: `[ts:src/modules/setup-checklist/setup-checklist.controller.ts:24]`-`[ts:src/modules/setup-checklist/setup-checklist.controller.ts:42]`. Guards run before the key check (auth rule 17): unauthenticated with a bad key is 401, forbidden 403. No route emits an SSE or domain event of its own (rule 17 for the settings notification).

## Rules

### A. Shape

1. `ChecklistItem` = `{ key: string, severity: 'required'|'recommended', done: boolean, dismissed: boolean, route: string[] }`; every field always present, no null. `key` is an open string (core keys plus registered ones, rule 11). `[ts:src/modules/setup-checklist/setup-checklist.service.ts:30]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:38]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:137]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:143]`
2. `done` and `dismissed` are independent: dismissing a done item, or a not-done one, only flips `dismissed`; `done` never reads the dismissal. `route` is the frontend route segments the "Configure" button navigates to (the client passes it to the router verbatim). `[ts:src/modules/setup-checklist/setup-checklist.service.ts:33]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:37]`, `[ts:src/modules/setup-checklist/checklist-item-registry.service.ts:8]`
3. The seven core items, fixed order, this is the response order (registered items follow, rule 11). `done` = the query returns at least one row:

| # | key | severity | route | `done` when | Table |
|---|---|---|---|---|---|
| 1 | `library` | required | `["/admin","settings","libraries"]` | any row | `libraries` |
| 2 | `quality-profile` | required | `["/admin","settings","quality-profiles"]` | any row | `quality_profiles` |
| 3 | `language-profile` | required | `["/admin","settings","language-profiles"]` | any row | `language_profiles` |
| 4 | `subtitle-provider` | recommended | `["/admin","settings","subtitle-providers"]` | any row with `enabled = true` | `subtitle_providers` |
| 5 | `notification` | recommended | `["/admin","settings","notifications"]` | any row (enabled or not) | `notification_connections` |
| 6 | `non-admin-user` | recommended | `["/admin","settings","users"]` | any user with `"isAdmin" <> true` (disabled users count) | `users` |
| 7 | `auto-approval-rule` | recommended | `["/admin","settings","auto-approval"]` | any row (`enabled` ignored) | `auto_approval_rules` |

`[ts:src/modules/setup-checklist/setup-checklist.service.ts:65]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:111]` (items at `:67`, `:73`, `:79`, `:85`, `:93`, `:99`, `:106`).
4. Items 1-3 read other domains' tables with no service call and no per-user scope: a restricted viewer is irrelevant, the route needs `settings.access`. Library ACL does not apply (the checklist asks "does any exist"). `[ts:src/modules/setup-checklist/setup-checklist.service.ts:70]`
5. Checks run concurrently (`Promise.all`, one count each); results keep item order. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:118]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:136]`
6. A check that throws (DB error, a registered item's callback) is logged at warn level (`Checklist item "<key>" check failed: <message>`) and yields `done: false`; the response is still 200 with every item. Rust keeps this per item for the core queries too. The dismissed-keys read is NOT inside that guard: its failure is a 500 (rule 9 makes malformed content non-failing). `[ts:src/modules/setup-checklist/setup-checklist.service.ts:123]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:135]`
7. `GET` has no side effects: no row is created when `app_settings` has no entry for the key. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:118]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:121]`

### B. Dismissal store

8. Storage: `app_settings` row `key = 'setup_checklist_dismissed_keys'`, `value` = JSON array of strings, e.g. `["library","notification"]`; global to the installation (no per-user column, no join table). Written as `JSON.stringify([...set])`: compact, insertion order (existing order preserved, a new key appended). The row is created on the first dismiss and kept (value `"[]"`) after the last un-dismiss. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:18]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:22]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:177]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:181]`
9. Read tolerance: absent row, NULL or empty value, invalid JSON, or a non-array JSON value -> empty set (no error, nothing repaired on read). Array members that are not strings, or are strings no longer known (rule 12), are silently dropped. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:160]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:175]`
10. The key is not in `PROTECTED_KEYS`, so `PUT /api/settings/setup_checklist_dismissed_keys` and `GET /api/settings` read and write it freely (settings spec: opaque text); tolerance rule 9 absorbs any garbage a client writes. `[ts:src/modules/settings/settings.service.ts:12]`-`[ts:src/modules/settings/settings.service.ts:23]`
11. Extension point `ChecklistItemRegistry`: `register(items)` upserts by `key` into a `Map` (a later registration of the same key replaces the earlier one, including a core key's `list()` position: core items stay first because the core list is spread first and a registered duplicate of a core key appears twice, once as core and once as registered), `list()` returns insertion order. Nothing in the repository registers an item (grep `ChecklistItemRegistry`: only this module and a client comment), so the registry is empty and the response has exactly the 7 core items. `[ts:src/modules/setup-checklist/checklist-item-registry.service.ts:19]`-`[ts:src/modules/setup-checklist/checklist-item-registry.service.ts:28]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:113]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:116]`
12. Known key = any key of core or registry (`isKnownKey`). Controller rejects an unknown key with 400 `Unknown checklist key: <raw>` on both POST and DELETE; the service re-checks on dismiss (silent no-op, unreachable through the controller) but not on un-dismiss. `[ts:src/modules/setup-checklist/setup-checklist.controller.ts:44]`-`[ts:src/modules/setup-checklist/setup-checklist.controller.ts:51]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:146]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:147]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:183]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:185]`
13. Any write through the service drops every unknown stored key (rule 9 filters on read): dismissals of keys whose registrant is no longer loaded are lost at the next dismiss/un-dismiss. Moot while the registry is empty. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:166]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:171]`
14. `dismiss(key)`: read set; already present -> return, NO write and no notification; else add and save. Response `{ok:true}` either way. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:146]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:152]`
15. `undismiss(key)`: read set; key absent -> return, no write; else delete and save. Response `{ok:true}` either way. `[ts:src/modules/setup-checklist/setup-checklist.service.ts:154]`-`[ts:src/modules/setup-checklist/setup-checklist.service.ts:158]`
16. Not atomic: two concurrent writes read the same set and the second save wins (lost update); first write of the key races on the `app_settings.key` unique index (second gets 500, `settings.md` rule 6). Rust: C?a. `[ts:src/modules/settings/settings.service.ts:65]`-`[ts:src/modules/settings/settings.service.ts:84]`
17. Every save goes through `SettingsService.set(key, value)` with no origin: it fires `notifyChange(key)` = Nest change listeners then the `settings.changed` domain event (`settings.md` rule 8). No listener reacts to this key (grep: the literal appears only in the service), so the notification has no consumer. Rust at S8 writes through the S1 settings write function so the `settings-changed` bridge keeps firing for Nest's listeners until S9. `[ts:src/modules/settings/settings.service.ts:41]`-`[ts:src/modules/settings/settings.service.ts:50]`, `[ts:src/modules/settings/settings.service.ts:80]`-`[ts:src/modules/settings/settings.service.ts:83]`

### C. Ownership across processes

18. Until S8 Nest is the only writer of the key; Rust S1 settings routes expose it as an ordinary key and read the database live, no cache (plan §15.1). At S8 the route and the Nest write path are deleted in the same milestone; no bridge. `[new]` (plan §0.2, §15.1)
19. Rust at S8 calls Rust code for every dependency (Bridges table); only the registry/plugin side has no earlier Rust home (rule 11, Q1). `[new]`

## SQL

Rust forms. Nest runs the same as `count()` and compares `> 0`; `EXISTS` is equivalent.

- Items 1-3, 5, 7: `SELECT EXISTS(SELECT 1 FROM <table>)` for `libraries`, `quality_profiles`, `language_profiles`, `notification_connections`, `auto_approval_rules`.
- Item 4: `SELECT EXISTS(SELECT 1 FROM subtitle_providers WHERE enabled)`.
- Item 6: `SELECT EXISTS(SELECT 1 FROM users WHERE "isAdmin" <> true)` (`isAdmin boolean NOT NULL DEFAULT false` in the baseline, so `Not(true)` has no NULL case).
- Read: `SELECT value FROM app_settings WHERE key = 'setup_checklist_dismissed_keys'`.
- Write (C?a, one transaction): `SELECT value FROM app_settings WHERE key = $1 FOR UPDATE` (absent -> the insert below creates it), compute the new array, then `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`. When the key row is absent two first writers both pass the `FOR UPDATE`; the `ON CONFLICT` makes the second win instead of 500, and a `pg_advisory_xact_lock(hashtext($1))` taken first serialises them `[assumed]` (the porter picks one; the contract is only "no lost update, no 500").

## Events

Emits nothing of its own. The save fires the `settings.changed` domain event through the settings write function (rule 17); consumed by nobody for this key. No SSE.

## Settings keys

| Key | Default | Parsing |
|---|---|---|
| `setup_checklist_dismissed_keys` | absent (= `[]`) | JSON array of strings; tolerant read (rule 9); written compact, insertion order (rule 8) |

## Jobs/timers

None.

## Bridges

No endpoint. Dependencies and the milestone after which the Rust port calls Rust code:

| Nest dependency | Used for | Rust home | Moves at |
|---|---|---|---|
| `CaslAbilityFactory` / `PoliciesGuard` (controller) | `Read`/`Manage` `'Settings'` | `fliks_domain::acl` + extractor | S1 |
| `SettingsService.get` / `set` (`app_settings`) | dismissal store, notify | Rust settings module + `settings-changed` bridge | S1 (key written by Nest until S8: this spec) |
| `Library` repo (`libraries`) | item 1 | libraries domain (table read) | S3 (DDL S0) |
| `QualityProfile`, `LanguageProfile` repos | items 2-3 | profiles domain | S5 (DDL S0) |
| `NotificationConnection` repo | item 5 | notifications domain | S4 |
| `User` repo | item 6 | users domain | S1 |
| `AutoApprovalRule` repo | item 7 | requests/auto-approval domain | S5 |
| `SubtitleProvider` repo | item 4 | subtitles domain | S6 |
| `ChecklistItemRegistry` (+ module) | extra items | none: no registrant exists; only plugin code could register | S8 (Q1) |

All seven core checks are plain table reads (no service call), so the port needs only the tables, which exist from S0 (sqlx owns the DDL); the milestone column says when each domain's Rust code appears, and the S8 query may call its repository function if one exists by then, otherwise the inline `EXISTS`. Nothing here needs the ACL duplication ("library ACL verify in Nest until S8", `counts.md`).

No new bridge is proposed. Known gap until S8: none. The routes stay in Nest until S8 and read the tables directly; if a domain's table is renamed or dropped by an earlier milestone, the affected item's check fails soft to `done: false` (rule 6) until S8.

## Deletes in Nest

Milestone S8.

- `backend/src/modules/setup-checklist/**`: `setup-checklist.controller.ts`, `setup-checklist.service.ts`, `setup-checklist.module.ts`, `checklist-item-registry.service.ts`, `checklist-item-registry.module.ts` (no spec file exists); remove `SetupChecklistModule` from `src/app.module.ts:26,81` imports; remove the 3 routes from `server/contract/nest-routes.json`.
- Re-grep before deleting: `ChecklistItemRegistryModule` has no importer outside the module today.
- Client: none (paths/bodies frozen, except the comment in `client/src/app/core/services/api/setup-checklist-api.service.ts` that cites the registry: update it if the registry is dropped, Q1).

## Vectors/parity

No §5.2 fixture set. Rust tests: `#[sqlx::test]` per item (empty table -> false, one row -> true; `subtitle-provider` with only a disabled row -> false; `non-admin-user` with only admins -> false, only a disabled non-admin -> true; `notification` and `auto-approval-rule` with a disabled row -> true), dismissed-keys parser (absent, `null`, `""`, `not json`, `{"a":1}`, `[1,"library","gone"]` -> `["library"]`), dismiss/undismiss idempotence (no second write, check `updatedAt` unchanged), insertion order, concurrent dismiss of two keys keeps both (C?a), a failing check yields `done:false` with the other six intact.

Parity scenarios (`server/parity/scenarios/setup-checklist/`, recorded against Nest): `setup-checklist-list-admin` (seed state, 7 items in order), `-list-forbidden` (`user` without `settings.access` 403), `-list-unauthenticated` (401), `-dismiss-roundtrip` (POST 201 `{ok:true}`, GET shows `dismissed:true`, repeat POST 201, DELETE 200, GET `dismissed:false`, repeat DELETE 200), `-dismiss-unknown-key` (POST and DELETE 400, strict message `Unknown checklist key: nope`), `-dismiss-forbidden` (403), `-dismiss-unauthenticated` (401), `-corrupt-store` (`PUT /api/settings/setup_checklist_dismissed_keys` with `"not json"`, GET shows all `dismissed:false`), `-stream-token` (deviation F8). Seed has libraries, profiles and users, so `done` for items 1-3 and 6 is true; the false cases are Rust tests. Free-text 400 message compared strictly (matches the Nest string).

## Open questions

- Security: none. Checked: GET returns booleans and static routes, readable only with `settings.access`; no per-user data; the dismissal is global by design. Stream-token acceptance is F8. No F row proposed.
- Correctness, proposed `C?a`: dismiss/undismiss is a non-atomic read-modify-write (rule 16: lost update, first-write 500). Rust does it in one transaction with a row lock and an upsert (SQL section). Contract unchanged.
- Q1. `ChecklistItemRegistry` has no registrant (rule 11): drop it at S8 (YAGNI, no extension point in the plugin pluginApi 2 design doc) or keep it as a Rust trait/registry for plugin-declared items? Default: drop it, the response stays the 7 core items, frozen contract holds; rule 13 then disappears. Needs the §8 design doc to confirm plugins do not declare items.
- Q2. Rule 10: should the key become a protected key at S8 (generic settings PUT refused, like `engine_url`)? Default: no, frozen behaviour; tolerant read already handles garbage.
- Q3. Rule 12: un-dismiss of a stale stored key is rejected as unknown; only relevant with a registry (Q1).
