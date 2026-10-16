# Spec: plugins (pluginApi 2, WASM components)

DRAFT. Sections marked `TODO` are unfinished. Sources: `backend/src/modules/plugins/**`, `backend/src/common/plugin-contract/**` (`host-methods.ts:122-308`, `manifest.ts`, `plugin-methods.ts`, `protocol.ts`, `ui-contribution.ts`), `backend/src/common/constants/{plugin-flags,plugin-permissions,core-scheduler-jobs}.ts`, `client/src/app/core/services/api/plugins-api.service.ts`, `docs/plugins.md`, plugins `fk-plugin-notify`, `fk-plugin-download`. Milestone: S8 (plan §8, §10). Tag paths are relative to `backend/` unless noted. Counts and setup checklist have their own specs (`counts.md`, `setup-checklist.md`); `counts.set` rules live there (C95).

## Routes

Frozen client contract (the Angular client uses only the routes marked "client"). Auth is `JwtOrApiKeyGuard` (Rust `Authed`, F8: a stream-scoped token is 401) then the policy. Error bodies of the install pipeline are `{code, message}` (Nest `PluginInstallException`, no `statusCode`/`error`); the client reads `error.code`.

| Method path | Policy | Request | Response | Errors | Notes |
|---|---|---|---|---|---|
| `GET /api/plugins` (client) | `Read Settings` | none | 200 `PluginSummary[]`: `{pluginId, name, version, kind:'data'\|'process', origin:'catalog'\|'manual', status:'active'\|'failed', statusReason:string\|null, signature:'official'\|'unverified'\|'unsigned', verifiedByKeyId:string\|null, enabled, processState:string\|null, statusMessage:string}` (`processState` null and `statusMessage` `''` for `data`); read from `plugin_packages` so a failed row shows | 401, 403 | `kind` stays `process` for wasm plugins (frozen type), the runtime is `manifest.runtime` |
| `GET /api/plugins/metrics` (client) | `Read Settings` | none | 200 `{pluginId, kind, metrics}[]`; `metrics` null for `data` and for a plugin not running, else `{hostCallCount, hostCallFailureCount, hostCallP95Ms:number\|null, restartCount, eventDropCount, residentSetSizeBytes:number\|null}` | 401, 403 | RSS field = wasm linear memory in use (rule 31); never `0` when unknown |
| `GET /api/plugins/ui` (client) | any authenticated | none | 200 `PluginUiEntry[]`: `{pluginId, name, contributions, configPages, i18n, releasePicker?}` | 401 | rules 40-44 |
| `POST /api/plugins/import/inspect` (client) | `Manage Settings` | multipart, one field `file` (<= 8 MiB), no other fields | 200 `PluginInspectReport` (rule 12) | 400 `No file uploaded`, 429 `PLUGIN_STAGING_LIMIT` | stages the bytes |
| `POST /api/plugins/import/confirm` (client) | `Manage Settings` | `{stagingId:/^[0-9a-f]{32}$/, sha256:/^[0-9a-f]{64}$/}` | 200 `{pluginId, version, status:'active'\|'failed', reason?, detail?}` | 400 validation, 404 `PLUGIN_STAGING_NOT_FOUND`, 409 `PLUGIN_STAGING_STALE`, 403 `PLUGIN_DENIED`, 422 any guard code | |
| `GET /api/plugins/sources` (client) | `Read Settings` | none | 200 `{id, url, enabled, hasPinnedKey, lastRefreshedAt, lastRefreshError, pluginCount}[]` by id | | never the key bytes |
| `POST /api/plugins/sources` (client) | `Manage Settings` | `{url, publicKey?:base64 32 bytes, enabled?}` | 201 source row | 400 `PLUGIN_SOURCE_INSECURE_URL`, `PLUGIN_SOURCE_BAD_KEY`; 409 `PLUGIN_SOURCE_DUPLICATE_URL` | |
| `PUT /api/plugins/sources/:id` (client) | `Manage Settings` | `{url?, publicKey?:string\|null, enabled?}` | 200 source row | as above, 404 `Plugin source #<id> not found` | C102 |
| `DELETE /api/plugins/sources/:id` (client) | `Manage Settings` | none | 204 | 404 | |
| `GET /api/plugins/sources/:id/catalog` (client) | `Read Settings` | none | 200 `{cachedCatalog, lastRefreshedAt, lastRefreshError}` | 404 | `cachedCatalog` = `{plugins: FilteredCatalogEntry[], denyList, signedByKeyId}` |
| `POST /api/plugins/sources/:id/refresh` (client) | `Manage Settings` | none | 201 `{ok:true}` or `{ok:false, reason:'insecure-url'\|'network-error'\|'bad-signature'\|'malformed-catalog', detail}` | 404 | 201 (no `@HttpCode`) |
| `POST /api/plugins/sources/:id/inspect` (client) | `Manage Settings` | `{pluginId, version}` | 201 `PluginInspectReport` | 404 `PLUGIN_CATALOG_VERSION_NOT_FOUND`, 422 `PLUGIN_CHECKSUM_MISMATCH`, 502/504/413 fetch codes | |
| `POST /api/plugins/:pluginId/enable` (client) | `Manage Settings` | none | 201 `PluginSummary` | 404 `PLUGIN_NOT_FOUND` | idempotent |
| `POST /api/plugins/:pluginId/disable` (client) | `Manage Settings` | none | 201 `PluginSummary` | 404 | idempotent |
| `POST /api/plugins/:pluginId/restart` | `Manage Settings` | none | 204 | 404, 400 `PLUGIN_NOT_PROCESS_TIER`, 503 `PLUGIN_UNAVAILABLE` | no client caller |
| `POST /api/plugins/:pluginId/events/test` (client) | `Manage Settings` | none | 201 `{configured, delivered, failures:string[]}` | 404 | rule 52 |
| `DELETE /api/plugins/:pluginId` (client) | `Manage Settings` | none | 204 | none (idempotent) | rule 20 |
| `GET /api/plugins/:pluginId/logo` (client, `<img>`) | `Read Settings` | none | 200 image bytes, headers `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` | 404 unknown or unregistered | |
| `GET /api/plugins/:pluginId/export` | `Read Settings` | none | 200 `{formatVersion:1, pluginId, pluginVersion, exportedAt, settings, tables}` | 404 | no client caller; credential-bearing, secrets in clear |
| `POST /api/plugins/:pluginId/import` | `Manage Settings` | the export document | 201 `{pluginId, tablesRestored, settingsRestored}` | 400 `PLUGIN_EXPORT_MALFORMED`/`_ID_MISMATCH`/`_SETTING_OUT_OF_SCOPE`, 409 `PLUGIN_NOT_READY`/`_VERSION_MISMATCH`/`_SCHEMA_NOT_EMPTY`/`_HAS_NO_SCHEMA` | no client caller |
| `ALL /api/plugins/:pluginId/*splat` (client) | the declared route's `policy` + `objectGuard` | method, path, query, JSON body | the plugin's `{status, headers, body}` | 403 (unknown route, policy or guard refused), 503 `PLUGIN_UNAVAILABLE`, 504 `PLUGIN_TIMEOUT` | rules 30-36 |

Route order: the concrete routes above are registered before the proxy wildcard (a test pins that `/api/plugins/{ui,metrics,sources,import/*}` never reach it).

## Rules

TODO. Rule numbers below are referenced by the table above; to be written in full with `[ts:file:line]` tags.

1-11 TODO: manifest (kind `data`|`process`, `runtime: "wasm"`, `pluginApi: 2`, `files` sha256, `memoryMb`, `database`, `routes`, `scopes`, `ingestRoots`, `jobs`, `permissions`, `network.internal` (Q3), `ui`, `events`, `i18n`; unknown keys refused), registration failure reasons, `incompatible-api` for `pluginApi` 1.
12. `PluginInspectReport` = `{installable, refusalCode?, detail?, stagingId?, sha256?, id?, name?, version?, kind?, signature?, signedByKeyId?, capabilities?, compatible?}`; a refusal carries only `installable:false, refusalCode, detail`. Capability strings keep today's prefixes (`ui:`, `config:`, `scope:`, `ingestroot:`, `job:`, `webhook`); `network:internal` is new and the client prints unknown capabilities raw (Q3).
13-19 TODO: archive guards V1-V8 (entries `plugin.json`, `plugin.json.sig`, `plugin.wasm`, `logo.svg|png`, max 4; caps 8 MiB archive, 24 MiB total, ratio 100, manifest 256 KiB, sig 256 B, logo 64 KiB; wasm cap is Q2), ed25519 over the manifest bytes with `release-2026` key, unsigned `process` refused unless `plugins.allow_unsigned`, `files` hash check at every load, denylist (authority = signing key), staging (cap 5, hourly sweep > 1 h), catalog refresh (https, 10 s, 1 MiB, `.sig`), filter by `pluginApi` and `fliks` range, `plugins.skip_compatibility_check`, auto-update (`plugins.auto_update`, official signature only).
20. Uninstall: forget registration, delete `plugin_registrations`, `plugin.<id>.*` settings (longest-id rule, rule 24), drop role and schema (`DROP OWNED`, `DROP SCHEMA CASCADE`, `DROP ROLE`), delete the data dir. Idempotent.
21-23 TODO: enable/disable/restart, upgrade over disabled stays disabled, `FLIKS_PLUGINS_DISABLED=1`.
24. Settings namespace: key owner = longest installed id with `plugin.<id>.` prefix; `config.get`/`config.set` touch only keys the caller owns [new] F69.
25-29 TODO: host imports (15 methods, scopes `HOST_METHOD_SCOPES`, registration re-checked per call), progress coalescing 1 s per media, events audience.
30-36 TODO: proxy. Known: response header allowlist `content-type, content-disposition, cache-control, etag, last-modified`; `Cache-Control: no-store` set first; status outside 100..599 becomes 502; only declared routes resolve (else 403); a plugin installed but not running answers 503 `PLUGIN_UNAVAILABLE`; call deadline 180 s then 504 `PLUGIN_TIMEOUT` (`errors.plugin_timeout`), other call failure 503 `errors.plugin_unavailable`; forwarded: method, raw path, query, body, `principal {kind:'delegated', userId}`.
31-39 TODO: supervisor. Numbers to keep: handshake 10 s, health every 15 s with 3 s reply (2 misses degraded, 4 recycle), backoff 1/2/4/8/16/30 s, ladder reset after 120 s ready, breaker 6 crashes in 10 min then `failed` until restart, shutdown 3 s then kill, log cap 64 KiB/min, event ring 64 (drop oldest), job deadline 60 min, host call 8 s (ingest 30 min), default memory 256 MB.
40-44 TODO: UI contributions (`GET /plugins/ui` filtered by ability; process plugins only when ready; i18n collision rule; releasePicker/pre-roll winner = smallest id).
45-49 TODO: jobs (manifest crons, reserved names, 409/400 mapping of `scheduler.md` rule 18), pre-roll (3 s, cap 5, sanitised).
50-52. Webhooks (data tier): event names = the 11 domain events; target = https URL or `setting:<key>`; delivery POST `{event, pluginId}`, 5 s, no redirect, response cap 64 KiB, at-most-once; resolve once and connect to the vetted address [new] F65; `test` returns `{configured, delivered, failures}`.
53+ TODO: backup/export/import (C103, C104).

## WIT package `fliks:plugin@2.0.0`

TODO (write out). Decided by the plan: exports `hello(core-version, config) -> manifest-check`, `health`, `job(name, job-id, args)`, `http(request) -> response` (fields method, path, query, body, principal), `event(name, payload)`, `config-changed(keys)`, `shutdown`; imports the 15 host methods, `db.query/execute/migrate`, `log`, `wasi:http/outgoing-handler`, `wasi:clocks`, `wasi:random`, `wasi:filesystem` on the data dir only.
Proposed shapes (not in the plan, see questions): `manifest-check = {id, version, plugin-api}`; `http` body and response body as `list<u8>`, headers as `list<tuple<string,string>>`, query as `list<tuple<string,string>>`; `db` params as a variant (null, boolean, int, float, text, bytes, json, text-list, int-list) sent in text format with unspecified OIDs so Postgres infers types like node-pg; rows decoded by OID (int8 to int, timestamptz to RFC 3339 UTC with ms, numeric to text, json/jsonb to json text).

## Host design

TODO. Decisions so far: no `installed/` tree and no sockets or pid files (the archive in `plugin_packages.archive` is hashed at every load and the component compiled in memory); data dir `data/<id>/` kept and preopened read-write; per-plugin role (LOGIN, password rotated each start, never leaves the host), `search_path = plugin_<id>`, `REFERENCES (id)` grants on `coreRefs`, pool owned by the host; `db.migrate` keeps the `_migrations(name, appliedAt)` ledger so existing installs adopt without re-running; limits: `StoreLimits` memory, epoch interruption for guest CPU, tokio timeouts for wall clock; S8 migration drops `plugin_registrations.childUid`.

## Outbound HTTP guard and `network.internal`

TODO (write out). Rule: the host resolves once, vets every address with `fliks_domain` internal-address ranges (same list as F58), connects to the vetted address, re-vets each redirect hop, http(s) only; `network.internal` granted at install consent lifts the internal ranges only. The download plugin needs it (qBittorrent, Torznab on the LAN).

## Events, Settings keys, Jobs/timers, Bridges, Deletes in Nest

TODO. Known: Bridges removed at S8: `POST /internal/plugins/pre-roll`, `GET /internal/events/progress`, `GET /internal/jobs`, `POST /internal/jobs/run`, `POST /internal/notifications/dispatch` (plugin caller); `POST /internal/ingest` was never built (known gaps in `bridge.md` close). Settings: `plugins.auto_update`, `plugins.skip_compatibility_check`, `plugins.allow_unsigned`, `plugins.allow_older_versions` (client only). Jobs: `RefreshPluginSources` (`0 3 * * *`, catalog refresh then auto-update), staging sweep hourly, plugin crons (`scheduler.md` rules 11, 18, 32). Deletes: `M/plugins/**`, `B/common/plugin-contract/**`, `PluginCountsCache*`, `PluginHostModule`, Nest bridge controllers above; client types repointed to the `ts-rs` output (plan §15).

## Deviations proposed (numbers: next free F65, C100)

| # | Today (Nest) | Rust behaviour |
|---|---|---|
| F65 | data-tier webhook delivery resolves the host, checks it, then the HTTP client resolves again (DNS rebinding window) | resolve once, connect to the vetted address, same connector as F58 |
| F66 | webhook target and catalog source URLs appear in logs, `failures[]` and `lastRefreshError` | no URL, userinfo or query in any of them |
| F67 | process plugins reach any address, internal included | plugin outbound HTTP refuses internal addresses unless the plugin holds the `network.internal` grant |
| F68 | TODO (reserved) | |
| F69 | `config.get` without keys returns, and `config.set` writes, every `plugin.<id>.*` key, including those of a plugin whose id extends it (`fliks` reads `fliks.download` secrets) | only keys whose longest installed owner id is the caller |
| C100 | concurrent install, upgrade, enable, disable, uninstall of one id race (unique-index 500) | one at a time per plugin id |
| C101 | TODO (reserved) | |
| C102 | `PUT /plugins/sources/:id` that changes `url` or `publicKey` keeps the old `cachedCatalog` | cleared with `lastRefreshedAt`, `lastRefreshError` |
| C103 | plugin import writes the tables, then refuses an out-of-scope settings key | every check before any write |
| C104 | import inserts tables in alphabetical order, so `fliks.download` (`indexer_stats` before `indexers`) fails on its foreign keys | tables inserted in foreign-key dependency order |

## Bridge and known gaps

TODO.

## Spike exit criteria (plan §8.3)

TODO (write out). Install, event delivery with retry, config page, health, restart, for `fk-plugin-notify` under a minimal host. Plus measurements the spec depends on: concurrency model (Q1), cold-start compile time (no cached `.cwasm`), `db` driver sending text params with unspecified OIDs, wasi-http connect to a vetted address.

## Vectors/parity

TODO. Scenarios to write against a fixture plugin: list/summary, sources CRUD and errors, inspect/confirm refusals per guard code, proxy 403/503/504/502, header allowlist, UI filtering per ability, export/import errors, webhook test, deviations F65-F69, C100-C104.

## Open questions (for the user)

1. Concurrency model. With wasip2 one Store runs one export at a time, so a 60 min `job` would block `health`, `http` and `event` (the Node plugins ran them concurrently; ring of 64 events would overflow). Options: wasip3 async exports, a pool of instances per plugin (state in the database), or serialise with a host-side "busy counts as healthy" rule. Spike decides, needs your sign-off.
2. Archive caps for `plugin.wasm` (Node cap is 8 MiB per entry, 24 MiB total): keep or raise?
3. Manifest form and grant of `network.internal` (a `network: {internal: true}` key is proposed; `permissions[]` cannot carry a dot). Is install consent the grant? An upgrade that newly requests it: fail closed until the admin reconfirms (auto-update skips)? Client shows `network:internal` raw until a client i18n key is added.
4. Timeout of a proxied call: dropping the wasm future loses the Store. Does a 504 restart the instance and count toward the breaker?
5. Value of `manifest-check` and whether the signed manifest is compared with the plugin's own.
6. Target Fliks version for the catalog row (`pluginApi 2 -> >=5.0.0 <6.0.0`?).
7. Reserve plugin ids `ui`, `metrics`, `sources`, `import` (today shadowed by concrete routes)?
8. Restoring a database dump that predates S8 holds plugins at `pluginApi 1`: they show `failed incompatible-api` until the catalog auto-update installs the wasm version (needs the catalog entry published first). Confirm that is acceptable.
9. Deferred issue candidate: no route discards a staged upload (5 staged max, 1 h sweep).
