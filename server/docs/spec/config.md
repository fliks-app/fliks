# Spec: configuration (environment variables)

Environment variables read by `fliks-server`, with defaults and parsing rules.

## Database

| Variable | Default | Parsing |
|---|---|---|
| `DB_HOST` | `'localhost'` | string as-is |
| `DB_PORT` | `5432` | `Number(raw)` |
| `DB_USERNAME` | `'fliks'` | string as-is |
| `DB_PASSWORD` | `'fliks'` for the connection; **`''` in the backup spawn env** (`PGPASSWORD`) | string as-is |
| `DB_NAME` | `'fliks'` | string as-is |

## Auth

| Variable | Default | Parsing |
|---|---|---|
| `JWT_SECRET` | none (else file `<conf>/.jwt-secret` or generated) | empty = unset (truthiness); file content trimmed; generated 32-byte hex written mode 0600; in-memory fallback if the write fails |
| `FLIKS_CONF_DIR` | none (writable probe: `override \|\| '/app/conf'`, then temp) | `.trim`, empty = unset |
| `JWT_EXPIRATION` | **`'1h'`** | the env string is parsed by `ms`; a unitless string is milliseconds (`3600` = 3.6 s token). The access cookie `Max-Age` equals the token lifetime; an unparsable value or one under 1 s falls back to the default with a warning |
| `STREAM_TOKEN_TTL` | `'12h'` | same as `JWT_EXPIRATION` (unitless = ms); `expiresAt` follows the same `ms` parser; an unparsable value or one under 1 s falls back to 12h with a warning |
| `REFRESH_TOKEN_TTL_DAYS` | `'60'` | `parseInt(raw, 10)`, must be finite and `> 0` else 60 |

## Engine

| Variable | Default | Parsing |
|---|---|---|
| `FLIKS_ENGINE_URL` | `''` | string as-is (`?? ''`); a saved URL takes precedence |
| `FLIKS_ENGINE_TOKEN` | `''` | string as-is (`?? ''`); a saved token takes precedence |
| `FLIKS_HOST_URL` | none (fallback: `http://127.0.0.1:` + the listen port) | string as-is, empty = unset |
| `PORT` | `4849` (set by the engine) | `Number(raw)`; non-numeric = default |

## Paths

| Variable | Default | Parsing |
|---|---|---|
| `FLIKS_DATA_DIR` | none (fallbacks: `FLIKS_IMAGES_DIR`, `cwd/images`, `cwd/data`, temp) | `.trim`, empty = unset |
| `FLIKS_IMAGES_DIR` | none (alias for the data dir) | `.trim`, empty = unset |
| `FLIKS_CACHE_DIR` | none (`<dataDir>/cache` or temp) | `.trim`, empty = unset |
| `FLIKS_RUNTIME_DIR` | none (`<override>/fliks-plugins` or temp) | `.trim`, empty = unset |

## CORS

| Variable | Default | Parsing |
|---|---|---|
| `CORS_ORIGIN` | none — if unset or empty after split, web origins default to `http://localhost:4200` and `http://localhost:4500`; native app origins always appended | split on `,`, each `.trim`, empty entries dropped |

## Plugins

| Variable | Default | Parsing |
|---|---|---|
| `FLIKS_PLUGINS_DISABLED` | none (enabled unless value is exactly `'1'`) | `=== '1'` |
| `TZ` | `'UTC'` | string as-is (`??`) |

## Metadata

| Variable | Default | Parsing |
|---|---|---|
| `TMDB_API_KEY` | `''` | string as-is; blank after `.trim` = not configured |
| `TVDB_API_KEY` | `''` | string as-is |
| `METADATA_STALE_AFTER_MONTHS` | `'3'` | `Math.max(1, parseInt(raw, 10) \|\| 3)` |

## Streaming lifetimes

Each is a positive integer.

| Variable | Default | Parsing |
|---|---|---|
| `STREAM_LIVE_SESSION_TTL_MS` | `30_000` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `STREAM_LIVE_SESSION_GC_INTERVAL_MS` | `5_000` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `STREAM_SESSION_REVIVE_TTL_MS` | `15 * 60 * 1000` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `STREAM_MAX_SESSIONS_PER_USER` | `10` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `STREAM_JOB_GRACE_MS` | `60_000` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `STREAM_JOB_FALLBACK_TIMEOUT_MS` | `30 * 60 * 1000` | `parseInt(raw, 10)`, finite and `> 0` else default |
| `TRANSCODE_CACHE_GC_INTERVAL_MS` | `5 * 60 * 1000` | `parseInt(raw, 10)`, finite and `> 0` else default |

The stream-lifetime cache TTL and max bytes are fixed constants, not env.

## Other

| Variable | Default | Parsing |
|---|---|---|
| `SERVE_STATIC_PATH` | none (when set, a static root served at `/`) | string, truthiness (empty = unset) |
| `FLIKS_GITHUB_REPO` | `'fliks-app/fliks'` | string as-is (`??`) |
| `FLIKS_DISABLE_UPDATE_CHECK` | `''` (disabled when `1`, `true`, or `yes`, case-insensitive) | `.trim.toLowerCase` in `1`/`true`/`yes` |
| `FLIKS_SUPERVISED` | none (truthy → supervisor) | truthiness (empty = unset) |
| `pm_id` | none (truthy → pm2) | truthiness |
| `INVOCATION_ID` | none (truthy → systemd) | truthiness |

## Server topology and test seams

| Variable | Default |
|---|---|
| `FLIKS_CAST_DIR` | `public` relative to cwd (`.trim`, empty = unset) |
| `FLIKS_TMDB_API_URL` | `https://api.themoviedb.org/3`; test seam (`metadata.md` rule 35, `.trim`, empty = unset) |
| `FLIKS_SUBTITLE_PROVIDERS_URL` | none; test-only seam, compiled only with the `parity` cargo feature (release builds do not enable it, the shipped binary ignores the variable; production provider bases are constants, `subtitle-providers.md` rule 46): the OpenSubtitles and Subdl bases move under `<url>/opensubtitles/api/v1`, `<url>/subdl/api/v1/subtitles` and `<url>` (`.trim`, empty = unset) |
| `FLIKS_TVDB_API_URL` | `https://api4.thetvdb.com/v4`; test seam |
| `FLIKS_TMDB_IMAGE_URL` | `https://image.tmdb.org/t/p`; test seam, also the host the image store rewrites to `original` |
