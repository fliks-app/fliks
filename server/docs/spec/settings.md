# Spec: settings (+ filesystem browse)

Covers the settings KV routes, the change notification and the filesystem browse route; every `settings.changed` consumer is listed under Events and Settings keys.

## Routes

All routes use `Authed` (a `scope:'stream'` token is 401, auth rule 12) and the policy `ability.can(Action.Manage, 'Settings')` = `manage:all` (isAdmin) or permission `settings.access`. Request bodies reject unknown properties (400).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/settings` | `Authed`; `Manage Settings` | none | `{ [key: string]: string \| null }`, every row, one entry per key | 401, 403 | none |
| `PUT /api/settings` | `Authed`; `Manage Settings` | `{ data: Record<string, string\|null> }` (`data` must be an object, values unchecked) | `{ ok: true }` | 400 (validation, protected key), 401, 403 | writes `app_settings` in one transaction; one change notification per entry (rules 7-8) |
| `GET /api/settings/:key` | `Authed`; `Manage Settings` | none | `{ key: string, value: string \| null }` (`value: null` when the row is absent, never 404) | 401, 403 | none |
| `PUT /api/settings/:key` | `Authed`; `Manage Settings` | `{ value?: string \| null }` | the saved row: `{ id: number, createdAt: ISO string, updatedAt: ISO string, key: string, value: string \| null }` | 400 (validation, protected key), 401, 403 | upsert in `app_settings`; change notification (rules 6, 8) |
| `GET /api/fs/browse?path=` | `Authed`; `Manage Settings` | query `path?: string` (no validation) | `{ current: string, parent: string \| null, entries: { name: string, path: string, isDirectory: true }[] }` | 400 `Cannot read "<abs>": <os message>`, 401, 403 | none (read-only directory listing) |

Route order: `PUT /settings` and `PUT /settings/:key` do not collide (`:key` never matches an empty segment).

## Rules

Store and encoding
1. Table `app_settings` is a flat KV store: unique `key` (varchar), `value` text nullable, plus `id` serial PK, `createdAt`/`updatedAt`. No schema, no key whitelist: any string key is accepted.
2. Values are opaque text. Convention only (not enforced): booleans `"true"`/`"false"`, numbers as decimal strings, structured values JSON-encoded in the string. Each consumer parses and defaults its own keys (see Settings keys). A stored `null` and an absent row are indistinguishable to consumers (a read returns the row's value or `null`).
3. `GET /api/settings` returns every row as one object `{key: value}`; a row whose value is NULL appears as `key: null`. Rows are sorted by key; clients do not depend on the order.
4. `GET /api/settings/:key` returns `{ key, value }` with `value: null` for an unknown key, status 200.
5. `PUT /api/settings/:key`: absent `value` and `value: null` both store NULL ; a non-string non-null `value` (number, boolean, object) is a 400 validation error. Empty string is stored as `''`. Body `{}` therefore clears the key. Extra body properties = 400.
6. `PUT /api/settings/:key` is an upsert on the unique `key` (`INSERT ... ON CONFLICT (key) DO UPDATE`, `updatedAt = now()`), so two concurrent first-writes of one key cannot fail on the unique constraint. Response is the saved row (parity ignores `$..updatedAt`, `$..createdAt`).
7. `PUT /api/settings` (bulk): `data` must be a non-array object (`@IsObject` rejects arrays, null, strings). Values are not type-checked: each is written as-is with no origin. Any protected key refuses the whole request (400) before anything is written; otherwise the whole object is written in one transaction. Response `{ ok: true }` (status 200). Non-string values are stored as text: numbers and booleans via JS `toString`, objects via `JSON.stringify` (keys in sorted order), arrays as a Postgres array literal (`{"1","a",NULL}`).
8. Every successful write (a single `PUT`, each bulk entry, and a `delete`) sends the change notification `(key, origin)` unconditionally, even when the stored value did not change.

Protected keys
9. Six keys have their own write path and are refused by the generic API with `400 { statusCode: 400, message: "\"<key>\" is managed by its own endpoint: <endpoint>", error: "Bad Request" }`: `livetv_restricted_groups`, `livetv_restricted_groups_exempt`, `livetv_restricted_groups_vanished` -> `PUT /livetv/admin/access/restricted-groups`; `engine_url`, `engine_token`, `engine_path_mappings` -> `PUT /engine/remote` (note: path text has no `/api` prefix). The check is on the exact key, before any DB access. Reads are not restricted (rule 16).
10. The bypass is the origin `own-module-write`, passed only by the owning services (engine remote route, livetv access service). The HTTP routes never set an origin, so the API cannot bypass. Other origins in use: a plugin id (config writes) and `plugin-import:<pluginId>` (backup restore).

Change notification
11. The in-process consumers of a change are the plugin host, the metadata language cache, the engine config and the QoE flag; they are fixed at startup.
12. The notification calls each consumer with the written keys and origin (a failing consumer never fails the write), then emits the domain event `{ type: 'settings.changed', key }` per key on the in-process domain bus.
13. `settings.changed` is a DOMAIN event only: it is not in the `SseEvent` union, is never sent to browsers/TV clients over `/api/system/events`, and no client references it (grep of client/appletv/cast-receiver is empty). Its only consumers are the plugin dispatchers (see Events).
14. The write is committed before listeners run; a listener reads the new value from the database (`settings.get`), never from the notification payload (the event payload carries only `key`; consumers also receive `origin`).
15. Consumers filter by `key` (exact, prefix or list); `origin` is used only by the plugin process dispatch, to skip the echo to the writing plugin.

Secrets (settings part)
16. `GET /api/settings` is the flat key/value object with secret keys removed plus one top-level `"secretsSet": [<full keys holding a non-empty value>]` (omitted when none). `GET /api/settings/:key` on a secret key is `{key, value: null, secretSet: bool}`. `PUT` on a secret key keeps the stored value when `value` is blank or absent and clears it on `null`; a plain key keeps rule 5 (absent and `null` clear). The `PUT /:key` response carries `value: null` for a secret key. A write that keeps a secret still notifies its key (rule 8).
17. Secret keys (no field schema, so a fixed list plus plugin forms): `engine_token`, `seerr_api_key`, `radarr_api_key`, `sonarr_api_key`, every `subtitle_translation_*_api_key`, and every `plugin.<id>.<key>` whose plugin form field is declared `secret: true` (read from `plugin_packages.manifest`). The imports endpoints fall back to the stored key when the body omits it.
18. Server-side consumers (services, plugin host `config.get`, backup export) read clear values; redaction applies to the HTTP response of the settings routes only.

Filesystem browse (`/api/fs/browse`)
19. Same admin gate as settings (`Manage Settings`), "same gate as library management".
20. Empty / whitespace-only / absent `path` -> roots view. Otherwise `path` is trimmed and resolved against the process cwd (a relative path is allowed and resolved).
21. POSIX roots view = the listing of `/` (`current: "/"`, `parent: null`). Windows roots view = drive letters `A:\`..`Z:\` that exist, `{ current: "", parent: null, entries: [{name: "C:\\", path: "C:\\", isDirectory: true}] }`; a drive root's `parent` is `""` (back to the roots view).
22. Entries: sub-directories only (a symlink to a directory is NOT listed, files are not listed, hidden directories are listed); `path` = `dir` joined with `name`; `isDirectory` is always `true`; entries are sorted case-insensitively by `name`, lowercase first (no accent folding); parity compares `entries` unordered. No limit or pagination.
23. `parent` = the parent directory of `dir`, `null` when it equals `dir` (the root).
24. Any `readdir` failure (missing, not a directory, EACCES) -> `400 BadRequest` with message `Cannot read "<resolved path>": <os error message>`. The OS part of the message is free text, not matched by clients, parity compares `statusCode`+`error` only.
25. Read-only: nothing is created, written or deleted. Parity browses generated dirs under `/tmp/fliks-parity/` only.

## SQL

| Purpose | SQL |
|---|---|
| list all | `SELECT id, "createdAt", "updatedAt", key, value FROM app_settings ORDER BY key ASC` |
| get one | `SELECT... FROM app_settings WHERE key = $1 LIMIT 1` |
| set | `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now() RETURNING id, "createdAt", "updatedAt"` |
| delete | `DELETE FROM app_settings WHERE key = $1` (used by plugin uninstall only) |

Schema (baseline migration): `CREATE TABLE "app_settings" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now, "updatedAt" TIMESTAMP NOT NULL DEFAULT now, "key" character varying NOT NULL, "value" text, CONSTRAINT "UQ_975c2db59c65c05fd9c6b63a2ab" UNIQUE ("key"), CONSTRAINT "PK_4800b266ba790931744b3e53a74" PRIMARY KEY ("id"))`. Direct raw reads of this table exist outside the settings module: `SELECT key, value FROM app_settings WHERE key = ANY($1)` in media import.

## Events

| Event | Kind | Audience | Payload | Emitter / consumers |
|---|---|---|---|---|
| `settings.changed` | domain (in-process, at-most-once, not SSE) | backend subscribers only | `{ type: 'settings.changed', key: string }` (no value, no origin) | emitter: the settings change notification; consumers: the plugin webhook dispatcher (POSTs to `data` plugins that declared `settings.changed`) and the plugin process dispatcher (sends it to every running process plugin); other domain subscribers filter by type and ignore it. Name is part of the plugin contract. |

No SSE event is emitted by this domain.

## Settings keys

This domain stores every key; the semantics belong to consumers. Registry of documented keys, with the in-memory state each consumer keeps:

| Key(s) | Consumer parsing/default | In-memory cache or listener |
|---|---|---|
| `streaming_segment_duration`, `streaming_qsv_preset`, `streaming_tonemap_algo`, `streaming_tonemap_curve`, `streaming_cache_max_gb`, `streaming_cache_ttl_hours`, `streaming_ffmpeg_slots`, `streaming_auto_quality_mode`, `streaming_auto_crop_enabled`, `streaming_gpu_render_node`, `streaming_throttle_enabled`, `streaming_throttle_threshold_seconds` | streaming settings cache load | cache + engine push |
| `cleanup_max_per_run` (10; invalid or negative = 10) | `MediaCleanup`, read per run (`cleanup.md` rule 4) | none |
| `qoe_enabled` (absent = on; only `'false'` disables), `qoe_retention_days` (30) | | enabled flag; retention read on demand |
| `livetv_segment_seconds`, `livetv_timeshift_minutes`, `livetv_probe_seconds`, `livetv_channel_idle_seconds`, `livetv_fast_zap` | integer with default; fast zap `'true'`/`'false'`/else null | engine push (engine push) |
| `subtitle_translation_*` (enabled, engine, max_concurrency, gemini_api_key/model, openai_base_url/api_key/model, libretranslate_url/api_key) | | cache |
| `metadata_language`, `metadata_region` | | cache |
| `party_voice_ice_servers` (JSON `{urls, username?, credential?}[]`; absent or invalid = public STUN) | parsed per `GET /api/parties/ice` (`watch-party.md`, Voice) | none |
| `plugin.<id>.<key>` | plugin `config.get` strips the prefix; writes tagged with the plugin id as origin | running-plugin notification |
| `plugins.auto_update` (only `'false'` disables), `plugins.skip_compatibility_check` (`'true'`), plugin allow-unsigned key | read on demand | none |
| `engine_url`, `engine_token`, `engine_path_mappings` (JSON `{from,to}[]`) | loaded by the engine remote settings loader, on init and on `reconfigure` | engine service fields, refreshed by an explicit `reconfigure` call, not by the change notification |
| `livetv_restricted_groups`, `_exempt`, `_vanished`, `livetv_guide_days_past/_future`, `livetv_stale_stream_days`, `livetv_slot_release_seconds`, `livetv_max_viewers_per_user` (`livetv-sessions.md` rule 39) | integer or JSON parse in the livetv services | none |
| `subtitle_auto_search`, `subtitle_search_interval`, `subtitle_upgrade_interval`, `subtitle_upgrade_threshold`, `subtitle_remove_hi_tags`, `subtitle_custom_exclusions`, `subtitle_burn_in_covers_language`, `subtitle_ocr_*` | read on demand by subtitle services | none |
| `naming_*`, `companion_file_extensions`, `search_missing_auto`, `markers_auto_detect_on_import`, `sprites_auto_generate_on_import`, `rss_sync_interval` | read on demand | none |
| `public_url` | cast-info | none |
| `seerr_api_key`, seerr URL key | seerr import | none |
| `setup_checklist_dismissed_keys` (JSON array) | setup checklist; written by the server with no origin | none |

Defaults and parsing live in each consumer's spec; unlisted keys are legal.

## Jobs/timers

none (no cron, no timer in this domain).

## Vectors/parity

No fixture set (no pure logic beyond the protected-key map, covered by the Rust tests in `server/crates/server/tests/it/settings.rs`).

Parity scenarios: 25 files in `server/parity/scenarios/settings/` and 5 in `server/parity/scenarios/fs/` (`fs` browses generated dirs under `/tmp/fliks-parity/` only; list and `entries` arrays are compared unordered). Ignore paths: `$..createdAt`, `$..updatedAt`, `$..id` on `PUT /api/settings/:key` responses. Cross-process effects (consumers refreshed, no origin echo to a plugin writer) are not observable through the HTTP runner; Rust tests cover them.
