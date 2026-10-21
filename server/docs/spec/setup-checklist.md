# Spec: setup-checklist

Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); settings store semantics in `settings.md`.

Three routes: list the onboarding items with a computed `done` flag and a stored `dismissed` flag, dismiss, un-dismiss. Dismissal is global (one JSON array in `app_settings`), not per user.

## Routes

3 routes. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard`; the extractor rejects a scoped stream token with 401. `Read Settings` and `Manage Settings` are both granted by `settings.access` or `manage:all` only (`libraries.md` rule 1), so the two policies are equivalent today.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/setup-checklist` | class guards; `ability.can(Action.Read, 'Settings')` | none | 200 `ChecklistItem[]` (rule 1), core items in fixed order (rule 3) | 401, 403 (auth rule 27) | none |
| `POST /api/setup-checklist/:key/dismiss` | class guards; `ability.can(Action.Manage, 'Settings')` | path `key` string (any string, URL-decoded); body ignored (no DTO: `{}`, empty, or extra keys all pass) | **201** `{ "ok": true }` | 400 `{"message":"Unknown checklist key: <key>","error":"Bad Request","statusCode":400}`; 401; 403 | read-modify-write of `app_settings.setup_checklist_dismissed_keys` unless already dismissed (rule 14) |
| `DELETE /api/setup-checklist/:key/dismiss` | same, `Manage Settings` | path `key` | 200 `{ "ok": true }` | 400 as above (the key must be KNOWN, even to un-dismiss); 401; 403 | same, unless not dismissed (rule 15) |

Guards run before the key check (auth rule 17): unauthenticated with a bad key is 401, forbidden 403. No route emits an SSE or domain event of its own (rule 17 for the settings notification).

## Rules

### A. Shape

1. `ChecklistItem` = `{ key: string, severity: 'required'|'recommended', done: boolean, dismissed: boolean, route: string[] }`; every field always present, no null. `key` is a string, one of the seven core keys (rule 3).
2. `done` and `dismissed` are independent: dismissing a done item, or a not-done one, only flips `dismissed`; `done` never reads the dismissal. `route` is the frontend route segments the "Configure" button navigates to (the client passes it to the router verbatim).
3. The seven core items, fixed order, this is the response order. `done` = the query returns at least one row:

| # | key | severity | route | `done` when | Table |
|---|---|---|---|---|---|
| 1 | `library` | required | `["/admin","settings","libraries"]` | any row | `libraries` |
| 2 | `quality-profile` | required | `["/admin","settings","quality-profiles"]` | any row | `quality_profiles` |
| 3 | `language-profile` | required | `["/admin","settings","language-profiles"]` | any row | `language_profiles` |
| 4 | `subtitle-provider` | recommended | `["/admin","settings","subtitle-providers"]` | any row with `enabled = true` | `subtitle_providers` |
| 5 | `notification` | recommended | `["/admin","settings","notifications"]` | any row (enabled or not) | `notification_connections` |
| 6 | `non-admin-user` | recommended | `["/admin","settings","users"]` | any user with `"isAdmin" <> true` (disabled users count) | `users` |
| 7 | `auto-approval-rule` | recommended | `["/admin","settings","auto-approval"]` | any row (`enabled` ignored) | `auto_approval_rules` |

4. Items 1-3 read other domains' tables with no service call and no per-user scope: a restricted viewer is irrelevant, the route needs `settings.access`. Library ACL does not apply (the checklist asks "does any exist").
5. Checks run concurrently, one existence query each; results keep item order.
6. A check that throws (DB error) is logged at warn level (`Checklist item "<key>" check failed: <message>`) and yields `done: false`; the response is still 200 with every item. The dismissed-keys read is NOT inside that guard: its failure is a 500 (rule 9 makes malformed content non-failing).
7. `GET` has no side effects: no row is created when `app_settings` has no entry for the key.

### B. Dismissal store

8. Storage: `app_settings` row `key = 'setup_checklist_dismissed_keys'`, `value` = JSON array of strings, e.g. `["library","notification"]`; global to the installation (no per-user column, no join table). Written as a compact JSON array, insertion order (existing order preserved, a new key appended). The row is created on the first dismiss and kept (value `"[]"`) after the last un-dismiss.
9. Read tolerance: absent row, NULL or empty value, invalid JSON, or a non-array JSON value -> empty set (no error, nothing repaired on read). Array members that are not strings, or are strings that are not known keys (rule 12), are silently dropped.
10. The key is not in `PROTECTED` (`server/crates/server/src/settings/routes.rs`), so `PUT /api/settings/setup_checklist_dismissed_keys` and `GET /api/settings` read and write it freely (settings spec: opaque text); tolerance rule 9 absorbs any garbage a client writes.
11. There is no registry of extra items: the response is exactly the 7 core items.
12. Known key = one of the 7 core keys. The route rejects an unknown key with 400 `Unknown checklist key: <raw>` on both POST and DELETE, so a stale stored key can never be un-dismissed.
13. Any write drops every unknown stored key (rule 9 filters on read).
14. `dismiss(key)`: read set; already present -> return, NO write and no notification; else add and save. Response `{ok:true}` either way.
15. `undismiss(key)`: read set; key absent -> return, no write; else delete and save. Response `{ok:true}` either way.
16. Not atomic: two concurrent writes read the same set and the second save wins (lost update) and the first write of the key races on the `app_settings.key` unique index (second gets 500). So each write runs in one transaction behind an advisory lock (SQL section): no lost update, no 500.
17. Every save writes with `settings::db::set(tx, key, value)` and then calls the settings change notification (`settings/routes.rs::notify`), which emits the `settings.changed` domain event (`settings.md` rule 8). No listener reacts to this key.

### C. Ownership across processes

18. Rust caches no such key and reads the database live; the generic `PUT /api/settings/:key` (rule 10) and the checklist routes are the writers.

## SQL

- Items 1-3, 5, 7: `SELECT EXISTS(SELECT 1 FROM <table>)` for `libraries`, `quality_profiles`, `language_profiles`, `notification_connections`, `auto_approval_rules`.
- Item 4: `SELECT EXISTS(SELECT 1 FROM subtitle_providers WHERE enabled)`.
- Item 6: `SELECT EXISTS(SELECT 1 FROM users WHERE "isAdmin" <> true)` (`isAdmin boolean NOT NULL DEFAULT false` in the baseline: no NULL case).
- Read: `SELECT value FROM app_settings WHERE key = 'setup_checklist_dismissed_keys'`.
- Write (one transaction): `SELECT value FROM app_settings WHERE key = $1 FOR UPDATE` (absent -> the insert below creates it), compute the new array, then the upsert of `settings::db::set` (`INSERT ... ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`). With the row absent two first writers would both pass `FOR UPDATE` and start from `[]`, so the transaction first takes `pg_advisory_xact_lock(hashtext($1))`, which serialises them.

## Events

Emits nothing of its own. The save fires the `settings.changed` domain event through the settings write function (rule 17); consumed by nobody for this key. No SSE.

## Settings keys

| Key | Default | Parsing |
|---|---|---|
| `setup_checklist_dismissed_keys` | absent (= `[]`) | JSON array of strings; tolerant read (rule 9); written compact, insertion order (rule 8) |

## Jobs/timers

None.

## Vectors/parity

No fixture set. Rust tests (`server/crates/server/tests/it/settings.rs`, `setup_checklist_items_and_dismissal`): `#[sqlx::test]` per item (empty table -> false, one row -> true; `subtitle-provider` with only a disabled row -> false; `non-admin-user` with only admins -> false, only a disabled non-admin -> true; `notification` and `auto-approval-rule` with a disabled row -> true), dismissed-keys parser (absent, `null`, `""`, `not json`, `{"a":1}`, `[1,"library","gone"]` -> `["library"]`), dismiss/undismiss idempotence (no second write, check `updatedAt` unchanged), insertion order, concurrent dismiss of two keys keeps both, a failing check yields `done:false` with the other six intact.

## Open questions

None.
