# Spec: configuration (environment variables)

Sources: grep of `process.env` and `config.get` / `ConfigService` over `backend/src` (runtime `.ts`, excluding `*.spec.ts` unless noted). Milestone: S-prep (inventory for S0 `config.rs`).

TypeORM CLI (`src/data-source.ts`) reads the same `DB_*` vars when running migrations outside Nest; cited below under database.

## Database

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `DB_HOST` | `'localhost'` | string as-is `[ts:src/app.module.ts:63]` | `[ts:src/app.module.ts:63]`, `[ts:src/modules/plugins/plugin-database.service.ts:358]`, `[ts:src/modules/scheduler/backup.service.ts:154]`, `[ts:src/data-source.ts:23]` |
| `DB_PORT` | `5432` | Nest: `get<number>` does not coerce, value is the raw string `[ts:src/app.module.ts:64]`; `Number()` in `[ts:src/data-source.ts:24]` | `[ts:src/app.module.ts:64]`, `[ts:src/modules/plugins/plugin-database.service.ts:359]`, `[ts:src/modules/scheduler/backup.service.ts:156]`, `[ts:src/data-source.ts:24]` (`Number(process.env.DB_PORT ?? 5432)`) |
| `DB_USERNAME` | `'fliks'` | string as-is | `[ts:src/app.module.ts:65]`, `[ts:src/modules/scheduler/backup.service.ts:158]`, `[ts:src/data-source.ts:25]` |
| `DB_PASSWORD` | `'fliks'` in TypeORM; **`''` in backup spawn env** | string as-is | `[ts:src/app.module.ts:66]`, `[ts:src/modules/scheduler/backup.service.ts:172]` (`PGPASSWORD`), `[ts:src/data-source.ts:26]` |
| `DB_NAME` | `'fliks'` | string as-is | `[ts:src/app.module.ts:67]`, `[ts:src/modules/plugins/plugin-database.service.ts:360]`, `[ts:src/modules/scheduler/backup.service.ts:160]`, `[ts:src/data-source.ts:27]` |
| `NODE_ENV` | `'development'` | `!== 'production'` is dev `[ts:src/app.module.ts:60]` | `[ts:src/app.module.ts:60]` — drives `synchronize` vs `migrationsRun` |

## Auth

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `JWT_SECRET` | none (else file `<conf>/.jwt-secret` or generated) | empty = unset (truthiness); file content trimmed; generated 32-byte hex written mode 0600; in-memory fallback if the write fails `[ts:src/common/utils/jwt-secret.ts:58]`–`[ts:src/common/utils/jwt-secret.ts:86]` | `[ts:src/common/utils/jwt-secret.ts:58]` |
| `FLIKS_CONF_DIR` | none (writable probe: `override \|\| '/app/conf'`, then temp) | `.trim()`, empty = unset `[ts:src/common/utils/jwt-secret.ts:41]` | `[ts:src/common/utils/jwt-secret.ts:41]` |
| `JWT_EXPIRATION` | **`'1h'`** (JWT sign) vs **`'7d'`** (access cookie max-age) | sign: `ms()` syntax via jsonwebtoken; cookie max-age: regex `^(\d+)([dhms])$` (i), else 7d `[ts:src/modules/auth/auth.service.ts:51]`–`[ts:src/modules/auth/auth.service.ts:58]`. A value outside the regex (e.g. `3600`) still signs but gets a 7d cookie | `[ts:src/modules/auth/auth.module.ts:41]`, `[ts:src/modules/auth/auth.service.ts:51]` |
| `STREAM_TOKEN_TTL` | `'12h'` | sign: `ms()` syntax; TTL ms: same regex as `JWT_EXPIRATION`, else 12h `[ts:src/modules/auth/auth.service.ts:285]`–`[ts:src/modules/auth/auth.service.ts:288]` | `[ts:src/modules/auth/auth.service.ts:268]`, `[ts:src/modules/auth/auth.service.ts:285]` |
| `REFRESH_TOKEN_TTL_DAYS` | `String(DEFAULT_TTL_DAYS)` → `'60'` | `parseInt(raw, 10)`, must be finite and `> 0` else 60 `[ts:src/modules/auth/refresh-token.service.ts:51]`–`[ts:src/modules/auth/refresh-token.service.ts:52]` | `[ts:src/modules/auth/refresh-token.service.ts:47]` (`DEFAULT_TTL_DAYS = 60` at line 16) |

## Engine

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `FLIKS_ENGINE_URL` | `''` | string as-is (`?? ''`); a saved URL takes precedence `[ts:src/modules/engine/engine.service.ts:212]` | `[ts:src/modules/engine/engine.service.ts:191]`, `[ts:src/modules/engine/engine.service.ts:212]`, `[ts:src/modules/engine/engine-remote.controller.ts:76]` |
| `FLIKS_ENGINE_TOKEN` | `''` | string as-is (`?? ''`); a saved token takes precedence `[ts:src/modules/engine/engine.service.ts:218]` | `[ts:src/modules/engine/engine.service.ts:218]` |
| `FLIKS_HOST_URL` | none (fallback below) | string as-is, empty = unset (`||`) `[ts:src/modules/engine/engine.service.ts:90]` | `[ts:src/modules/engine/engine.service.ts:90]` — if unset, `http://127.0.0.1:` + (`Number(process.env.PORT) || 4848`) at `[ts:src/modules/engine/engine.service.ts:91]` |
| `PORT` | `4848` | listen/host URL: `Number(PORT) \|\| 4848`; `[ts:src/common/stream-public-base-url.util.ts:21]`: `PORT \|\| 4848` without `Number()` (string interpolation) | `[ts:src/main.ts:94]`, `[ts:src/modules/engine/engine.service.ts:91]`, `[ts:src/common/stream-public-base-url.util.ts:21]` (localhost fallback only) |

## Paths

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `FLIKS_DATA_DIR` | none (see `intendedDataDir()` fallbacks: legacy `FLIKS_IMAGES_DIR`, `cwd/images`, `cwd/data`, temp) | `.trim()`, empty = unset `[ts:src/common/constants/paths.ts:12]` | `[ts:src/common/constants/paths.ts:12]` |
| `FLIKS_IMAGES_DIR` | none (deprecated alias for data dir) | `.trim()`, empty = unset `[ts:src/common/constants/paths.ts:14]` | `[ts:src/common/constants/paths.ts:14]` |
| `FLIKS_CACHE_DIR` | none (`<dataDir>/cache` or temp) | `.trim()`, empty = unset `[ts:src/common/constants/paths.ts:60]` | `[ts:src/common/constants/paths.ts:60]` |
| `FLIKS_RUNTIME_DIR` | none (`<override>/fliks-plugins` or temp) | `.trim()`, empty = unset `[ts:src/common/constants/paths.ts:80]` | `[ts:src/common/constants/paths.ts:80]` |

## CORS

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `CORS_ORIGIN` | none — if unset or empty after split, web origins default to `http://localhost:4200` and `http://localhost:4500`; native app origins always appended | split on `,`, each `.trim()`, empty entries dropped `[ts:src/main.ts:24]`–`[ts:src/main.ts:27]` | `[ts:src/main.ts:24]` |

## Plugins

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `FLIKS_PLUGINS_DISABLED` | none (enabled unless value is exactly `'1'`) | `=== '1'` `[ts:src/common/constants/plugin-flags.ts:10]` | `[ts:src/common/constants/plugin-flags.ts:10]` (`FLIKS_PLUGINS_DISABLED_ENV`) |
| `TZ` | `'UTC'` | string as-is (`??`) `[ts:src/modules/plugins/supervisor/spawn-plan.ts:127]` | `[ts:src/modules/plugins/supervisor/spawn-plan.ts:127]` — passed into plugin child env |

## Metadata

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `TMDB_API_KEY` | `''` | string as-is; blank after `.trim()` = not configured `[ts:src/modules/scheduler/scheduler.service.ts:391]` | `[ts:src/modules/metadata-providers/providers/tmdb.provider.ts:156]`, `[ts:src/modules/metadata-providers/metadata-provider.registry.ts:35]`, `[ts:src/modules/metadata-providers/metadata-provider.registry.ts:46]`, `[ts:src/modules/media/media-service/media-import.service.ts:73]`, `[ts:src/modules/scheduler/scheduler.service.ts:391]`, `[ts:src/modules/scheduler/scheduler.service.ts:760]` |
| `TVDB_API_KEY` | `''` | string as-is | `[ts:src/modules/metadata-providers/providers/tvdb.provider.ts:96]`, `[ts:src/modules/metadata-providers/metadata-provider.registry.ts:38]`, `[ts:src/modules/metadata-providers/metadata-provider.registry.ts:47]` |
| `METADATA_STALE_AFTER_MONTHS` | `'3'` | `Math.max(1, parseInt(raw, 10) \|\| 3)` `[ts:src/modules/scheduler/scheduler.service.ts:766]` | `[ts:src/modules/scheduler/scheduler.service.ts:766]` |

## Streaming lifetimes

Read via `readEnvPositiveInt(name, fallback)` in `[ts:src/modules/streaming/lifetime-constants.ts:20]`.

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `STREAM_LIVE_SESSION_TTL_MS` | `30_000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:29]` |
| `STREAM_LIVE_SESSION_GC_INTERVAL_MS` | `5_000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:32]` |
| `STREAM_SESSION_REVIVE_TTL_MS` | `15 * 60 * 1000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:37]` |
| `STREAM_MAX_SESSIONS_PER_USER` | `10` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:42]` |
| `STREAM_JOB_GRACE_MS` | `60_000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:46]` |
| `STREAM_JOB_FALLBACK_TIMEOUT_MS` | `30 * 60 * 1000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:49]` |
| `TRANSCODE_CACHE_GC_INTERVAL_MS` | `5 * 60 * 1000` | `readEnvPositiveInt`: `parseInt(raw, 10)`, finite and `> 0` else default `[ts:src/modules/streaming/lifetime-constants.ts:20]`–`[ts:src/modules/streaming/lifetime-constants.ts:24]` | `[ts:src/modules/streaming/lifetime-constants.ts:56]` |

(`StreamLifetime.cacheTtlMs` / `cacheMaxBytes` use fixed constants, not env — `[ts:src/modules/streaming/lifetime-constants.ts:52]`.)

## Other

| Variable | Default (expression) | Parsing | Reads |
|---|---|---|---|
| `SERVE_STATIC_PATH` | none (when set, second `ServeStaticModule` root at `/`) | string, truthiness (empty = unset) `[ts:src/app.module.ts:51]` | `[ts:src/app.module.ts:48]`, `[ts:src/app.module.ts:51]` |
| `FLIKS_GITHUB_REPO` | `'fliks-app/fliks'` | string as-is (`??`) `[ts:src/modules/scheduler/update-check.service.ts:5]` | `[ts:src/modules/scheduler/update-check.service.ts:5]` |
| `FLIKS_DISABLE_UPDATE_CHECK` | `''` (disabled when `1`, `true`, or `yes`, case-insensitive) | `.trim().toLowerCase()` in `1`/`true`/`yes` `[ts:src/modules/scheduler/update-check.service.ts:10]`–`[ts:src/modules/scheduler/update-check.service.ts:11]` | `[ts:src/modules/scheduler/update-check.service.ts:10]` |
| `FLIKS_SUPERVISED` | none (truthy → supervisor) | truthiness (empty = unset) `[ts:src/modules/scheduler/system.controller.ts:141]` | `[ts:src/modules/scheduler/system.controller.ts:141]` |
| `pm_id` | none (truthy → pm2) | truthiness `[ts:src/modules/scheduler/system.controller.ts:142]` | `[ts:src/modules/scheduler/system.controller.ts:142]` |
| `INVOCATION_ID` | none (truthy → systemd) | truthiness `[ts:src/modules/scheduler/system.controller.ts:143]` | `[ts:src/modules/scheduler/system.controller.ts:143]` |

Bootstrap sets `UV_THREADPOOL_SIZE` to `'16'` before imports (`[ts:src/main.ts:2]`); it is not read from the environment.

## fliks-server only (not read by Nest yet)

Planned for S0 strangler topology (phase-2 plan §9.5 lists them; defaults from §4.3). No Nest `file:line`.

| Variable | Default (§4.3) |
|---|---|
| `FLIKS_NEST_URL` | none |
| `FLIKS_NEST_CMD` | `` `node dist/main` `` |
| `FLIKS_NODE_BIN` | none |
| `FLIKS_NEST_ENTRY` | none |
| `FLIKS_NEST_PORT` | `PORT + 1` |
| `FLIKS_BRIDGE_TOKEN` | generated |
