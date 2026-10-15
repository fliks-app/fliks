# Spec: bootstrap

Sources: `[ts:src/main.ts]`, `[ts:src/app.module.ts]`, `[ts:src/common/pipes/tolerant-validation.pipe.ts]`, `[ts:src/common/filters/file-too-large.filter.ts]`. Milestone: S0.

## Routes

(none — cross-cutting HTTP stack only)

## Rules

1. Global HTTP prefix is `api`; route `engine/resolve` is excluded from the prefix (served at `/engine/resolve`, not `/api/engine/resolve`). `[ts:src/main.ts:76]`
2. Global validation uses `TolerantValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. `[ts:src/main.ts:77]`–`[ts:src/main.ts:82]`
3. DTOs decorated with `@AllowExtraProperties()` skip `forbidNonWhitelisted` (unknown fields stripped only). Pipe implementation: `[ts:src/common/pipes/tolerant-validation.pipe.ts:8]`–`[ts:src/common/pipes/tolerant-validation.pipe.ts:27]`. Example consumer: `[ts:src/modules/streaming/dto/device-profile.dto.ts:56]`.
4. Global `ClassSerializerInterceptor` strips `@Exclude()` fields from serialized entity instances returned by controllers. `[ts:src/main.ts:87]` Confirmed `@Exclude` credentials: `User.passwordHash` `[ts:src/modules/users/entities/user.entity.ts:22]`–`[ts:src/modules/users/entities/user.entity.ts:23]`; `LiveTvSource.password` `[ts:src/modules/livetv/entities/livetv-source.entity.ts:32]`–`[ts:src/modules/livetv/entities/livetv-source.entity.ts:33]`. Plan also names `media_servers.apiKey`; entity has no `@Exclude` on `apiKey` `[ts:src/modules/users/entities/media-server.entity.ts:17]`.
5. Default Nest HTTP exceptions serialize as JSON `{ statusCode, message, error }`. `[assumed]` (no custom global exception formatter beyond `ClientAbortExceptionFilter`.)
6. `FileTooLargeFilter` on selected upload routes maps `PayloadTooLargeException` to HTTP 413 with body `{ statusCode: 413, error: 'Payload Too Large', message: 'file_info.import_err_too_large' }`. `[ts:src/common/filters/file-too-large.filter.ts:8]`–`[ts:src/common/filters/file-too-large.filter.ts:11]`; applied on `[ts:src/modules/media/media.controller.ts:273]` and `[ts:src/modules/media/media.controller.ts:772]`.
7. Middleware wraps `res.writeHead`: any response with `statusCode >= 400` gets `Cache-Control: no-store, no-cache, must-revalidate`. `[ts:src/main.ts:64]`–`[ts:src/main.ts:66]`
8. CORS: origins from `CORS_ORIGIN` (comma-separated) when non-empty, else `http://localhost:4200` and `http://localhost:4500`; always union `https://localhost`, `capacitor://localhost`, `http://localhost`; `credentials: true`. `[ts:src/main.ts:23]`–`[ts:src/main.ts:43]`
9. Express `trust proxy` is `true` (honour `X-Forwarded-*` for client IP). `[ts:src/main.ts:47]`
10. JSON request body size limit is Express’s default 100 kB; `main.ts` does not call `express.json({ limit })`. `[assumed]` Express default 100 kB per phase-2 plan §3.1.
11. At boot, before listen: `CREATE EXTENSION IF NOT EXISTS pg_trgm` on the TypeORM connection. `[ts:src/main.ts:20]`–`[ts:src/main.ts:21]`
12. Static files: `/cast` → `join(__dirname, '..', 'public')` with `index: false`. `[ts:src/app.module.ts:42]`–`[ts:src/app.module.ts:45]`
13. When `SERVE_STATIC_PATH` is set, serve that directory at `/`, excluding `/api/{*path}` and `/cast/{*path}`. `[ts:src/app.module.ts:48]`–`[ts:src/app.module.ts:54]`
14. TypeORM: `synchronize` when `NODE_ENV !== 'production'`, `migrationsRun` when production; connection pool `extra.max: 30`. `[ts:src/app.module.ts:60]`–`[ts:src/app.module.ts:77]`
15. Listen port: `Number(process.env.PORT) || 4848`. `[ts:src/main.ts:94]`–`[ts:src/main.ts:95]`

## SQL

- Boot: `CREATE EXTENSION IF NOT EXISTS pg_trgm` — enables trigram similarity used by media search. `[ts:src/main.ts:21]`

## Events

(none at bootstrap)

## Settings keys

(none at bootstrap)

## Jobs/timers

(none at bootstrap)

## Bridges

(none at bootstrap)

## Deletes in Nest (S0)

Per phase-2 plan §10 S0: remove ServeStatic config, liveness controller, TypeORM migration running / synchronize, and boot `pg_trgm` SQL from Nest once Rust owns them.

## Vectors/parity

Cross-cutting layers verified via S0 parity scenarios through the forwarder (phase-2 plan §5.3 / P6), not domain-specific fixtures.
