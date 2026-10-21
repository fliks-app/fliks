# Spec: bootstrap

Cross-cutting HTTP stack: prefix, validation, serialization, error bodies, CORS, static files, boot-time database setup and listen port.

## Routes

(none — cross-cutting HTTP stack only)

## Rules

1. Global HTTP prefix is `api`; route `engine/resolve` is excluded from the prefix (served at `/engine/resolve`, not `/api/engine/resolve`).
2. Global validation is tolerant: unknown fields are rejected (`forbidNonWhitelisted`) except on DTOs marked as allowing extra properties, where unknown fields are stripped only; request bodies are transformed to the declared types.
3. DTOs that allow extra properties skip the unknown-field rejection (unknown fields stripped only). Example consumer: the device-profile DTO of streaming.
4. Serialized entities omit credential fields: `User.passwordHash` and `LiveTvSource.password` are never returned. `media_servers.apiKey` is serialized as `""` and `apiKeySet: boolean` says whether a key is stored; a write with `apiKey` absent or `""` keeps the stored key, a non-empty string replaces it, `null` clears it. The media-servers edit form starts empty with an "unchanged" hint; a 4.x client re-sending `""` keeps the key but can no longer clear it.
5. HTTP errors serialize as JSON `{ statusCode, message, error }`. The only exception filter is the client-abort one, which delegates to the default error body unless the client aborted.
6. On selected upload routes a payload over the limit maps to HTTP 413 with body `{ statusCode: 413, error: 'Payload Too Large', message: 'file_info.import_err_too_large' }`; applied on the two media upload routes.
7. Any response with `statusCode >= 400` gets `Cache-Control: no-store, no-cache, must-revalidate`.
8. CORS: origins from `CORS_ORIGIN` (comma-separated) when non-empty, else `http://localhost:4200` and `http://localhost:4500`; always union `https://localhost`, `capacitor://localhost`, `http://localhost`; `credentials: true`.
9. The server trusts the proxy: `X-Forwarded-*` is honoured for the client IP.
10. JSON and urlencoded request bodies are limited to 100 kB; no route overrides the limit.
11. At boot, before listen: `CREATE EXTENSION IF NOT EXISTS pg_trgm` on the database connection.
12. Static files: `/cast` serves the `public` directory next to the binary, with no index document.
13. When `SERVE_STATIC_PATH` is set, serve that directory at `/`, excluding `/api/{*path}` and `/cast/{*path}`. Any other unmatched path falls back to that directory's `index.html` (SPA fallback). There is no `/internal` route: `/internal/**` falls to the SPA fallback like any unknown non-`/api` path, and answers the `Cannot <METHOD>` 404 when no client directory is set.
14. Database: pending migrations run at boot (`fliks-server migrate` runs them alone); the connection pool holds at most 30 connections.
15. Listen port: `PORT` when set to a number, else 4849 (the engine fronts the HTTP API on 4848). The desktop bundles write the engine and `fliks-server` output to `logs/server-<date>.log`.

## SQL

- Boot: `CREATE EXTENSION IF NOT EXISTS pg_trgm` — enables trigram similarity used by media search.

## Events

(none at bootstrap)

## Settings keys

(none at bootstrap)

## Jobs/timers

(none at bootstrap)

## Vectors/parity

Cross-cutting layers are verified by parity scenarios through the front door, not by domain fixtures.
