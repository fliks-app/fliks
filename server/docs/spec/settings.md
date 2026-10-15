# Spec: settings (+ filesystem browse)

Sources: `src/modules/settings/{settings.controller,settings.service,settings.module}.ts`, `src/modules/settings/entities/app-setting.entity.ts`, `src/modules/filesystem/{filesystem.controller,filesystem.service}.ts`, every `addChangeListener` / `onDomain` consumer (listed under Bridges). Milestone: S1. Tag paths are relative to `backend/`.

## Routes

All guards `JwtOrApiKeyGuard, PoliciesGuard` (class level), no `SessionTokenGuard`; a `scope:'stream'` token has no `Settings` ability in Nest and is 401 in Rust (F8, auth rule 12). Policy on every route: `ability.can(Action.Manage, 'Settings')` = `manage:all` (isAdmin) or permission `settings.access` `[ts:src/modules/auth/casl/casl-ability.factory.ts:53]`, `[ts:src/modules/auth/casl/casl-ability.factory.ts:132]`. Global pipe: `whitelist + forbidNonWhitelisted + transform` `[ts:src/main.ts:78]` (unknown body property = 400).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/settings` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); ``(ability) => ability.can(Action.Manage, 'Settings')`` | none | `{ [key: string]: string \| null }`, every row, one entry per key | 401, 403 | none |
| `PUT /api/settings` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | `SetBulkDto { data: Record<string, string\|null> }` (`@IsObject`, values unvalidated) | `{ ok: true }` | 400 (validation, protected key), 401, 403 | writes `app_settings` entry by entry via `set`; `notifyChange(key)` per entry (rules 7-8) |
| `GET /api/settings/:key` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | none | `{ key: string, value: string \| null }` (`value: null` when the row is absent, never 404) | 401, 403 | none |
| `PUT /api/settings/:key` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | `SetSettingDto { value?: string \| null }` (`@IsString @IsOptional`) | the saved `AppSetting` entity: `{ id: number, createdAt: ISO string, updatedAt: ISO string, key: string, value: string \| null }` | 400 (validation, protected key), 401, 403 | find-then-save in `app_settings`; `notifyChange(key)` (rules 6, 8) |
| `GET /api/fs/browse?path=` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | query `path?: string` (no validation) | `FsListing { current: string, parent: string \| null, entries: { name: string, path: string, isDirectory: true }[] }` | 400 `Cannot read "<abs>": <os message>`, 401, 403 | none (read-only directory listing) |

Manifest filter: `jq '.[]|select(.path|test("^/api/(settings|fs)"))'` = 5 routes. Manifest lines `[ts:src/modules/settings/settings.controller.ts:26]`, `:32`, `:38`, `:45`; `[ts:src/modules/filesystem/filesystem.controller.ts:16]`. Route order: `PUT /settings` and `PUT /settings/:key` do not collide (`:key` never matches an empty segment).

## Rules

Store and encoding
1. Table `app_settings` is a flat KV store: unique `key` (varchar), `value` text nullable, plus `id` serial PK, `createdAt`/`updatedAt` (BaseEntity) `[ts:src/modules/settings/entities/app-setting.entity.ts:59]`, `[ts:src/common/entities/base.entity.ts:7]`. No schema, no key whitelist: any string key is accepted.
2. Values are opaque text. Convention only (not enforced): booleans `"true"`/`"false"`, numbers as decimal strings, structured values JSON-encoded in the string `[ts:src/modules/settings/entities/app-setting.entity.ts:6]`. Each consumer parses and defaults its own keys (see Settings keys). A stored `null` and an absent row are indistinguishable to consumers (`get` returns `row?.value ?? null`) `[ts:src/modules/settings/settings.service.ts:60]`.
3. `GET /api/settings` returns every row as one object `{key: value}`; a row whose value is NULL appears as `key: null` `[ts:src/modules/settings/settings.service.ts:55]`. Nest's key order is the database collation's; clients do not depend on it, parity compares it unordered and Rust sorts by key.
4. `GET /api/settings/:key` returns `{ key, value }` with `value: null` for an unknown key, status 200 `[ts:src/modules/settings/settings.controller.ts:32]`.
5. `PUT /api/settings/:key`: absent `value` and `value: null` both store NULL (`dto.value ?? null`); a non-string non-null `value` (number, boolean, object) is a 400 validation error `[ts:src/modules/settings/settings.controller.ts:9]`, `[ts:src/modules/settings/settings.controller.ts:41]`. Empty string is stored as `''`. Body `{}` therefore clears the key. Extra body properties = 400.
6. `PUT /api/settings/:key` is find-then-save: read the row by key, update `value` in place or insert a new one; no transaction, no upsert. Two concurrent first-writes of one key race on the unique constraint (second gets a 500). Response is the saved entity `[ts:src/modules/settings/settings.service.ts:76]`. `updatedAt` of the returned entity after an update is the value TypeORM returns for the write `[assumed]` (parity ignores `$..updatedAt`, `$..createdAt`).
7. `PUT /api/settings` (bulk): `data` must be a non-array object (`@IsObject` rejects arrays, null, strings) `[ts:src/modules/settings/settings.controller.ts:15]`. Values are NOT validated by the DTO (nested type unchecked): `data` values reach `set` as-is. Each entry is written sequentially through `set(key, value)` with no origin, in `Object.entries` order (integer-like keys first, ascending, then insertion order) `[ts:src/modules/settings/settings.service.ts:87]`. Nest is not atomic: the first protected key aborts with 400 after the earlier entries were written and notified. **C2** `[new]`: Rust refuses any protected key before writing and writes the whole object in one transaction. Response `{ ok: true }` (status 200, the route has no `@HttpCode`). Non-string values are stored as node-pg writes them (`prepareValue` text): numbers and booleans via JS `toString`, objects via `JSON.stringify`, arrays as a Postgres array literal (`{"1","a",NULL}`) `[ts:node_modules/pg/lib/utils.js:50]` `[ts:src/modules/settings/settings.service.ts:87]`; Rust reproduces it (object keys in sorted order).
8. Every successful write (`set`, per bulk entry; and `delete`) calls `notifyChange(key, origin)` unconditionally, even when the stored value did not change `[ts:src/modules/settings/settings.service.ts:83]`, `[ts:src/modules/settings/settings.service.ts:95]`.

Protected keys
9. Six keys have their own write path and are refused by the generic API with `400 { statusCode: 400, message: "\"<key>\" is managed by its own endpoint: <endpoint>", error: "Bad Request" }`: `livetv_restricted_groups`, `livetv_restricted_groups_exempt`, `livetv_restricted_groups_vanished` -> `PUT /livetv/admin/access/restricted-groups`; `engine_url`, `engine_token`, `engine_path_mappings` -> `PUT /engine/remote` (note: path text has no `/api` prefix) `[ts:src/modules/settings/settings.service.ts:12]`, `[ts:src/modules/settings/settings.service.ts:70]`. The check is on the exact key, before any DB access. Reads are not restricted (see F5).
10. The bypass is `origin === 'own-module-write'` (`OWN_MODULE_ORIGIN`), passed only by the owning services (engine remote controller, livetv access service) `[ts:src/modules/settings/settings.service.ts:8]`, `[ts:src/modules/engine/engine-remote.controller.ts:100]`, `[ts:src/modules/livetv/services/livetv-access.service.ts:79]`. The HTTP routes never set an origin, so the API cannot bypass. Other origins in use: a plugin id (config writes) and `plugin-import:<pluginId>` (backup restore) `[ts:src/modules/plugins/host/fliks-host.service.ts:1187]`, `[ts:src/modules/plugins/plugin-backup.service.ts:167]`.

Change notification
11. `SettingsService` holds an ordered in-process list of listeners `(key, origin?) => void`, registered once at module init by consumers and never removed `[ts:src/modules/settings/settings.service.ts:35]`, `[ts:src/modules/settings/settings.service.ts:40]`.
12. `notifyChange` calls every listener synchronously in registration order, each in its own try/catch (a throwing listener never fails the write; an async listener's rejection is not caught here), then emits the domain event `{ type: 'settings.changed', key }` on the in-process domain bus (`EventsService.emitDomain`) `[ts:src/modules/settings/settings.service.ts:44]`.
13. `settings.changed` is a DOMAIN event only: it is not in the `SseEvent` union, is never sent to browsers/TV clients over `/api/system/events`, and no client references it (grep of client/appletv/cast-receiver is empty) `[ts:src/modules/scheduler/events.service.ts:270]`. Its only consumers are the plugin dispatchers (see Events). Plan §3.2 / §6.4 call it "SSE `settings.changed`": that is inaccurate.
14. The write is committed before listeners run; a listener reads the new value from the database (`settings.get`), never from the notification payload (the payload carries only `key`, plus `origin` to listeners).
15. Listeners use `key` filters (exact, prefix or list) and `origin` only in the plugin process listener (skip echo to the writing plugin) `[ts:src/modules/plugins/plugin-process.service.ts:71]`. Origin must therefore be preserved by the bridge.

F5 (settings part)
16. [new] F5: `GET /api/settings` is the flat key/value object with secret keys removed plus one top-level `"secretsSet": [<full keys holding a non-empty value>]` (omitted when none). `GET /api/settings/:key` on a secret key is `{key, value: null, secretSet: bool}`. `PUT` on a secret key keeps the stored value when `value` is blank or absent and clears it on `null`; a plain key keeps rule 5 (absent and `null` clear). The `PUT /:key` response carries `value: null` for a secret key. A write that keeps a secret does not notify (rule 8). Convention of `[ts:src/common/utils/secret-fields.util.ts:8]`, `[ts:src/common/utils/secret-fields.util.ts:25]`; the engine settings page moves to it in S2 with `/api/engine/remote` (plan §15.1).
17. [new] F5: secret keys (no field schema, so a fixed list plus plugin forms): `engine_token`, `seerr_api_key`, `radarr_api_key`, `sonarr_api_key`, every `subtitle_translation_*_api_key`, and every `plugin.<id>.<key>` whose plugin form field is declared `secret: true` (read from `plugin_packages.manifest`) `[ts:src/modules/settings/entities/app-setting.entity.ts:28]`, `[ts:src/modules/settings/entities/app-setting.entity.ts:55]`, `[ts:src/modules/imports/seerr-request-import.service.ts:30]`, `[ts:src/modules/engine/engine-remote-config.ts:2]`. The imports endpoints (Nest until S5) fall back to the stored key when the body omits it.
18. [new] F5: server-side consumers (Nest services, plugin host `config.get`, backup export) keep reading clear values; redaction applies to the HTTP response of the settings routes only. Backup/plugin-backup read through `SettingsService.getAll`, not the route `[ts:src/modules/plugins/plugin-backup.service.ts:144]`.

Filesystem browse (`/api/fs/browse`)
19. Same admin gate as settings (`Manage Settings`), "same gate as library management" `[ts:src/modules/filesystem/filesystem.controller.ts:14]`.
20. Empty / whitespace-only / absent `path` -> roots view `[ts:src/modules/filesystem/filesystem.service.ts:25]`. Otherwise `path` is trimmed and `path.resolve`d against the process cwd (a relative path is allowed and resolved) `[ts:src/modules/filesystem/filesystem.service.ts:28]`.
21. POSIX roots view = the listing of `/` (`current: "/"`, `parent: null`) `[ts:src/modules/filesystem/filesystem.service.ts:71]`. Windows roots view = drive letters `A:\`..`Z:\` that exist, `{ current: "", parent: null, entries: [{name: "C:\\", path: "C:\\", isDirectory: true}] }`; a drive root's `parent` is `""` (back to the roots view) `[ts:src/modules/filesystem/filesystem.service.ts:56]`, `[ts:src/modules/filesystem/filesystem.service.ts:74]`.
22. Entries: sub-directories only (`Dirent.isDirectory()`; a symlink to a directory is NOT listed, files are not listed, hidden directories are listed); `path` = `path.join(dir, name)`; `isDirectory` is always `true`; Nest sorts by `name` with `localeCompare` (ICU) `[ts:src/modules/filesystem/filesystem.service.ts:38]`; parity compares `entries` unordered, Rust sorts case-insensitively, lowercase first (no accent folding). No limit or pagination.
23. `parent` = `path.dirname(dir)`, `null` when `dirname(dir) === dir` (the root) `[ts:src/modules/filesystem/filesystem.service.ts:74]`.
24. Any `readdir` failure (missing, not a directory, EACCES) -> `400 BadRequest` with message `Cannot read "<resolved path>": <node error message>` `[ts:src/modules/filesystem/filesystem.service.ts:30]`. The OS part of the message is Node's text (`ENOENT: no such file or directory, scandir '<p>'`); free text, not matched by clients, parity compares `statusCode`+`error` only.
25. Read-only: nothing is created, written or deleted. Parity must browse generated dirs under `/tmp/fliks-parity/` only.

## SQL

All via TypeORM `Repository<AppSetting>`; equivalents:

| Purpose | Equivalent SQL | Tag |
|---|---|---|
| list all | `SELECT id, "createdAt", "updatedAt", key, value FROM app_settings ORDER BY key ASC` | `[ts:src/modules/settings/settings.service.ts:56]` |
| get one | `SELECT ... FROM app_settings WHERE key = $1 LIMIT 1` | `[ts:src/modules/settings/settings.service.ts:61]` |
| set | the same select, then `UPDATE app_settings SET value = $2, "updatedAt" = now() WHERE id = $1` or `INSERT INTO app_settings (key, value) VALUES ($1, $2) RETURNING id, "createdAt", "updatedAt"` (save, no upsert) | `[ts:src/modules/settings/settings.service.ts:76]` |
| delete | `DELETE FROM app_settings WHERE key = $1` (used by plugin uninstall only) | `[ts:src/modules/settings/settings.service.ts:94]`, `[ts:src/modules/plugins/plugin-install.service.ts:271]` |

Schema (unchanged, baseline migration): `CREATE TABLE "app_settings" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "key" character varying NOT NULL, "value" text, CONSTRAINT "UQ_975c2db59c65c05fd9c6b63a2ab" UNIQUE ("key"), CONSTRAINT "PK_4800b266ba790931744b3e53a74" PRIMARY KEY ("id"))` `[ts:src/migrations/1777816212948-baseline.ts:122]`. Note the baseline declares `TIMESTAMP` (without tz) while the entity declares `timestamptz`; the S0 ledger spec owns that drift. Direct raw reads of this table exist outside the service: `SELECT key, value FROM app_settings WHERE key = ANY($1)` in media import `[ts:src/modules/media/media-service/media-import.service.ts:108]`, `[ts:src/modules/media/media-service/media-import.service.ts:224]`.

## Events

| Event | Kind | Audience | Payload | Emitter / consumers |
|---|---|---|---|---|
| `settings.changed` | domain (in-process, at-most-once, not SSE) | backend subscribers only | `{ type: 'settings.changed', key: string }` (no value, no origin) | emitter `SettingsService.notifyChange` `[ts:src/modules/settings/settings.service.ts:52]`; consumers: `PluginWebhookDispatcher` (POSTs to `data` plugins that declared `settings.changed`) `[ts:src/modules/plugins/plugin-webhook-dispatcher.service.ts:40]`, `PluginProcessEventDispatcher` (`emitToAll('settings.changed', event)` to every running process plugin) `[ts:src/modules/plugins/plugin-process-event-dispatcher.service.ts:18]`; other `onDomain` subscribers filter by type and ignore it `[ts:src/modules/requests/request-lifecycle.service.ts:90]`, `[ts:src/modules/scheduler/post-import.service.ts:68]`. Name is part of the plugin contract `[ts:src/common/plugin-contract/manifest.ts:22]`. |

No SSE event is emitted by this domain.

## Settings keys

This domain stores every key; the semantics belong to consumers. Registry of documented keys `[ts:src/modules/settings/entities/app-setting.entity.ts:8]` and keys found in code, with the in-memory state each consumer keeps:

| Key(s) | Consumer parsing/default | In-memory cache or listener |
|---|---|---|
| `streaming_segment_duration`, `streaming_qsv_preset`, `streaming_tonemap_algo`, `streaming_tonemap_curve`, `streaming_cache_max_gb`, `streaming_cache_ttl_hours`, `streaming_ffmpeg_slots`, `streaming_auto_quality_mode`, `streaming_auto_crop_enabled`, `streaming_gpu_render_node`, `streaming_throttle_enabled`, `streaming_throttle_threshold_seconds` | `StreamingSettingsCache.load` `[ts:src/modules/streaming/streaming-settings-cache.service.ts:65]` | cache + engine push (listener L1) |
| `qoe_enabled` (absent = on; only `'false'` disables), `qoe_retention_days` (30) | `[ts:src/modules/qoe/qoe.service.ts:37]` | `enabledFlag` (listener L2); retention read on demand |
| `livetv_segment_seconds`, `livetv_timeshift_minutes`, `livetv_probe_seconds`, `livetv_channel_idle_seconds`, `livetv_fast_zap` | `intOr(raw, default)`; fast zap `'true'`/`'false'`/else null `[ts:src/modules/livetv/services/livetv-session.service.ts:96]` | engine push (listener L3) |
| `subtitle_translation_*` (enabled, engine, max_concurrency, gemini_api_key/model, openai_base_url/api_key/model, libretranslate_url/api_key) | `[ts:src/modules/subtitles/subtitle-translation-settings-cache.service.ts:38]` | cache (listener L4) |
| `metadata_language`, `metadata_region` | `[ts:src/modules/metadata-providers/metadata-settings-cache.service.ts:35]` | cache (listener L5) |
| `plugin.<id>.<key>` | plugin `config.get` strips the prefix; writes tagged with the plugin id as origin | running-plugin notification (listener L6) |
| `plugins.auto_update` (only `'false'` disables), `plugins.skip_compatibility_check` (`'true'`), plugin allow-unsigned key | read on demand | none |
| `engine_url`, `engine_token`, `engine_path_mappings` (JSON `{from,to}[]`) | loaded by `EngineService.loadRemoteSettings`, on init and on `reconfigure()` `[ts:src/modules/engine/engine.service.ts:222]` | engine service fields, refreshed by an explicit `reconfigure()` call, NOT by a listener `[ts:src/modules/engine/engine-remote.controller.ts:107]` |
| `livetv_restricted_groups`, `_exempt`, `_vanished`, `livetv_guide_days_past/_future`, `livetv_stale_stream_days`, `livetv_slot_release_seconds` | `settingInt` / JSON parse in livetv services `[ts:src/modules/livetv/services/livetv-guide.service.ts:579]`, `[ts:src/modules/livetv/services/livetv-sources.service.ts:612]` | none |
| `subtitle_auto_search`, `subtitle_search_interval`, `subtitle_upgrade_interval`, `subtitle_upgrade_threshold`, `subtitle_remove_hi_tags`, `subtitle_custom_exclusions`, `subtitle_burn_in_covers_language`, `subtitle_ocr_*` | read on demand by subtitle services | none |
| `naming_*`, `companion_file_extensions`, `search_missing_auto`, `markers_auto_detect_on_import`, `sprites_auto_generate_on_import`, `rss_sync_interval` | read on demand | none |
| `public_url` | cast-info `[ts:src/modules/auth/auth.controller.ts:166]` | none |
| `seerr_api_key`, seerr URL key | seerr import | none |
| `setup_checklist_dismissed_keys` (JSON array) | setup checklist; written by Nest with no origin `[ts:src/modules/setup-checklist/setup-checklist.service.ts:22]` | none |

Defaults and parsing live in each consumer's spec; unlisted keys are legal.

## Jobs/timers

none (no cron, no timer in this domain).

## Bridges

`settings-changed` (Nest, added S1, removed S9; plan §6.4, shape in `bridge.md`). After a write committed by Rust, Rust tells Nest so that Nest-resident listeners run:
1. Input `{ keys: string[] (non-empty), origin?: string }`; per key, in order, Nest runs `SettingsService.notifyChange(key, origin)` (listeners in registration order, then `emitDomain({type:'settings.changed', key})`). `settings.changed` travels only through this bridge, never through `emit`, so the domain event fires once.
2. It does not write the DB (Rust already committed) and does not re-run the protected-key check; `engine_url` / `engine_token` in `keys` also make Nest re-adopt the engine.
3. Rust calls it once per committed write with all its keys, after the commit (a bulk write is one call); a failure is logged, not surfaced.
4. `origin` is carried unchanged (generic HTTP writes: absent).

Listeners the bridge must trigger (all registered in Nest `onModuleInit` / constructor), with the port milestone after which the listener lives in Rust:

| # | Listener | Key filter | Effect | Tag | Moves |
|---|---|---|---|---|---|
| L1 | `StreamingSettingsCache` | prefix `streaming_` | drop cache and in-flight load (`epoch++`); if engine enabled, reload and `engine.pushStreaming(...)` | `[ts:src/modules/streaming/streaming-settings-cache.service.ts:120]` | S2 |
| L2 | `QoeService` | `qoe_enabled` | re-read flag (`!== 'false'`) | `[ts:src/modules/qoe/qoe.service.ts:263]` | S2 |
| L3 | `LiveTvSessionService` | the 5 `livetv_*` config keys | `pushConfig()` -> engine live config | `[ts:src/modules/livetv/services/livetv-session.service.ts:136]` | S7 |
| L4 | `SubtitleTranslationSettingsCache` | prefix `subtitle_translation_` | drop cache | `[ts:src/modules/subtitles/subtitle-translation-settings-cache.service.ts:38]` | S6 |
| L5 | `MetadataSettingsCache` | `metadata_language`, `metadata_region` | drop cache | `[ts:src/modules/metadata-providers/metadata-settings-cache.service.ts:35]` | S3 |
| L6 | `PluginProcessService.onSettingChanged` | prefix `plugin.<id>.` of a running plugin (longest id wins) | `supervisor.emitConfigChanged([key])` unless `origin === id` | `[ts:src/modules/plugins/plugin-process.service.ts:66]` | S8 |
| D1 | domain subscribers of `settings.changed` | any | plugin webhooks + process plugins | see Events | S8 |

Reverse direction (Nest writes, Rust must see): there is no Nest to Rust settings bridge. Rust caches no key that Nest still writes until that key's owner milestone (`engine_*` S2, live TV keys S7, plugin config S8, `setup_checklist_dismissed_keys` S8), so in S1 Rust reads settings from the database on every use (plan §15.1).

Also `drop-connections` and `emit` bridges are owned by auth/users specs, not here.

## Deletes in Nest

S1 (plan §10): delete `src/modules/settings/settings.controller.ts` (whole file, 50 lines) and drop `SettingsController` from `controllers` in `src/modules/settings/settings.module.ts:13`; delete `src/modules/filesystem/**` (`filesystem.controller.ts`, `filesystem.module.ts`, `filesystem.service.ts`, `filesystem.service.spec.ts`) and remove `FilesystemModule` from `src/app.module.ts` imports. KEEP `settings.service.ts`, `settings.module.ts` (without the controller), `entities/app-setting.entity.ts`, `settings.service.spec.ts`: the service stays as the read cache and as the writer for Nest-internal callers, and `PROTECTED_KEYS` stays (Nest-internal `set` calls from other modules still pass through it). `forwardRef(() => AuthModule)` in `settings.module.ts:11` is only needed by the controller's guards and can go with it. The `@CheckPolicies` import of `Action 'Settings'` subject stays in the CASL factory (Nest still guards its own routes).

## Vectors/parity

Fixture sets (§5.2): none required (no pure logic beyond the protected-key map, covered by a table test replaying the 6 keys). One small vector file `settings/protected-keys.json` (6 keys x endpoint text, error message) is enough.

Parity scenarios (§5.3): one file per case in `server/parity/scenarios/settings/` and `server/parity/scenarios/fs/` (deviation cases carry `"deviation": "F<n>"`; `fs` browses generated dirs under `/tmp/fliks-parity/` only; list and `entries` arrays are compared unordered).
Cross-process effects (Nest listeners refreshed, no origin echo to a plugin writer) are not observable through the HTTP runner: Rust bridge-client tests and the Nest endpoint's specs cover them.
Ignore paths: `$..createdAt`, `$..updatedAt`, `$..id` on `PUT /api/settings/:key` responses.
