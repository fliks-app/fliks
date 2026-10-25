# Spec: engine glue (client, config owner, resolver, remote-engine admin, events consumer)

Engine side: `fliks-engine/PROTOCOL.md` and `fliks-engine/crates/core/src/api.rs`, cited `[engine:...]`.

Scope: everything the host does *to* the engine and the one thing the engine does to the host (`POST /engine/resolve`). Not here: playback-info orchestration, presence/QoE reactions to engine events (`presence.md`, `qoe.md`), the engine's own behaviour.

## Routes

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/engine/remote` | guards `JwtOrApiKeyGuard`, `PoliciesGuard`; policy `(ability) => ability.can(Action.Manage, 'Settings')` | none | `{url: string, token: string, pathMappings: {from: string, to: string}[], status: 'off'\|'up'\|'down', processUrl: string, mismatch?: true, error?: string}` | 401, 403 | none |
| `PUT /api/engine/remote` | same, `Manage Settings` | body `PutEngineRemoteDto`: `url: string`, `token: string` (both `@IsString`, empty allowed), `pathMappings: {from: string, to: string}[]` (`@IsArray`, nested `@IsString`) | 200, the same snapshot as GET (after the reconnect) | 400 validation (global pipe, `forbidNonWhitelisted`), 401, 403 | writes 3 settings keys, reconnects the engine (rules R4-R6) |
| `POST /api/engine/remote/test` | same, `Manage Settings` | body `TestEngineRemoteDto`: `url: string`, `token: string`, `probePath?: string` | 200 `EngineConnectionTestResult` (below), never an error status for an unreachable engine | 400, 401, 403 | none (does not adopt) |
| `POST /engine/resolve` (no `/api` prefix) | guard `EngineHostGuard` only (no JWT, no CASL; policies `''`), `@HttpCode(200)`; body `ResolveRequestDto` | `{mediaId: number\|string, credential: string, purpose: 'stream'\|'download'\|'sprite'\|'subtitle'\|'live', subtitleId?: int>=0, streamIndex?: int>=0}` | 200 `ResolveResult` `{allow: boolean, ownerId?: string, ttlS: number, path?: string, format?: string}` | 401 wrong host token, 400 validation, 5xx host fault | none |

4 routes (the 3 `/api/engine/remote*` plus `/engine/resolve`), all above. `/engine/resolve` is excluded from the `api` prefix.

`EngineConnectionTestResult` = `{ok: false, error: string}` or `{ok: true, engineVersion: string, protocolVersion: number, probeOk?: boolean, probeError?: string}`.

## Rules

### A. HTTP client (`createEngineClient`)

1. Base URL has one trailing `/` stripped; every call sends `Authorization: Bearer <token>`; `Content-Type: application/json` only when a body is present (body `JSON.stringify`); no other headers. Engine side: control plane is bearer `FLIKS_ENGINE_TOKEN`, loopback. `[engine:PROTOCOL.md:9]`
2. The reply is parsed as JSON only when `content-type` contains `json` (a parse failure yields `undefined`). A 2xx gives `{data, response}`; any other status gives `{error: <parsed JSON body, e.g. {code}>, response}`. A 2xx without a JSON body (204) has `data === undefined`.
3. `{name}` placeholders in the path are replaced by `encodeURIComponent(String(v))`; query entries whose value is `undefined` are dropped, others `encodeURIComponent`-encoded as `k=v&k=v`.
4. `stream('/v1/events', signal)` is a raw `GET` with `Accept: text/event-stream` and the bearer, aborted by the caller's signal; the `Response` is returned unread.
5. Control calls time out after 10 s; transport failures reject; the retry loops of rule 27 have deadlines; `GET /v1/events` has none (the 45 s idle watchdog of rule 49 ends a dead connection).

### B. Boot, hello poll, adopt

6. Configured engine = saved `engine_url` (trimmed, non-empty) else env `FLIKS_ENGINE_URL`; token = saved `engine_token` (trimmed, non-empty) else env `FLIKS_ENGINE_TOKEN`. Saved values are read from settings only at init and on `reconfigure()`. Url or token empty: error log `FLIKS_ENGINE_URL/FLIKS_ENGINE_TOKEN unset: playback is unavailable without the engine`, no client, no polling.
7. Boot awaits the handshake (`whenReady()` resolves whatever the outcome). Consumers start themselves after it (`HostHardwareService`, `EngineEventsService`, live TV config).
8. `connect`: up to 20 attempts of `GET /v1/hello`, 500 ms apart (the sleep also follows the 20th failure). A hello that throws or is non-2xx counts as no answer. First answer: `adopt`; adopted: next poll in 10 000 ms. 20 failures: error log `engine did not answer /v1/hello: no playback until it does, retrying in the background`, next poll after `backoff()` = delay doubling from 500 (1000, 2000, 4000, 8000, then 10 000 cap `POLL_MS`); `delay` is reset to 500 by a successful adopt.
9. `adopt(hello)`: refused when `protocolVersion < 1` (log `engine protocol P < 1 (engine V): engine disabled`) or when `features` lacks `probe` or `capabilities` (log `engine lacks features a, b: engine disabled`). Refusal: `client = null`, returns false; the poll continues with the hello backoff of rule 8 and the engine stays degraded (`status: down`) until it is adopted. Engine side: `hello` = `{engineVersion, protocolVersion, features[], instanceId}`. `[engine:PROTOCOL.md:3]` `[engine:crates/core/src/api.rs:41]`
10. On acceptance: `GET /v1/config`; `revision = cfg?.revision ?? 0` (a non-2xx gives revision 0); `lastPushed = ''` (forces the next push); `instanceId`, `features` stored; client adopted; `reachable = true`; log `engine <v> (protocol P, features a,b)`; when `notify` is set the `onConnect` listeners run. A failing `GET /v1/config` (transport) never aborts the boot or the poll, it counts as no adoption and retries like rule 9; a non-2xx still gives revision 0.
11. Derived state: `enabled` = client adopted; `runtime` = enabled and `features` contains `sessions`, `serve` and `events`; `status` = `'off'` if no URL is configured, else `'down'` if no client but a candidate exists, `'off'` if neither, else `'up'` when the last hello answered and `'down'` otherwise; `gatewayMismatch` = saved URL and `FLIKS_ENGINE_URL` both non-empty and different after trimming trailing slashes; `engineFeatures` = features of the adopted engine (empty without one).
12. Poll every 10 000 ms (`unref`'d timer): `hello`; `reachable = !!hello`. No answer: next in 10 s if connected, else `backoff()`. Same `instanceId` as adopted: next in 10 s. Otherwise (engine restarted, or never connected): if connected log `engine restarted: reloading config and capabilities`; `adopt(notify=true)`; accepted: next in 10 s; refused: retried with the hello backoff (rule 9); thrown: next in 10 s.
13. `reconfigure()`: `epoch++`, timer cleared, client/candidate dropped, `reachable=false`, `ready = init(notify=true)`, awaited; if still the current epoch and a client was adopted, `await push()`. Every await in `init`/`connect`/`adopt`/`tick` checks the epoch, so a handshake begun before a reconfigure never adopts.
14. `testConnection(url, token, probePath?)`: url/token trimmed, empty ones fall back to the configured/effective ones; both still empty: `{ok:false, error:'Engine URL and token are required'}`. Own client, `GET /v1/hello`; no data or non-2xx or throw: `{ok:false, error:'The streaming engine at <url> did not answer'}`. Success: `{ok:true, engineVersion, protocolVersion}` without any protocol/feature check. With a non-blank `probePath` (trimmed): `POST /v1/probe {media:{mediaFileId:0, path}}`: non-2xx adds `probeOk:false, probeError:'probe -> <status>'`; `ok:false` body adds `probeOk:false, probeError: error ?? 'Probe failed'`; 2xx ok adds `probeOk:true`; a throw adds `probeOk:false, probeError:'Probe did not answer'`. Never adopts the engine. `[engine:PROTOCOL.md:29]`

### C. Config owner (serialized, revisioned push)

15. Inputs held in memory: `streaming` (set by `pushStreaming`), `livetv` (set by `pushLivetv`, "goes out with the streaming ones, which the engine needs first"), `pathMappings` (settings, rule 28), `hostToken`. `push()` does nothing while no client or no `streaming` is known.
16. Serialization: each push runs after the previous one settled (`pushing` promise chain; a failure rejects only its own caller, the chain continues).
17. Dedupe: key = `JSON.stringify({streaming, livetv, pathMappings})` (key order of the objects as built: `toEngineStreaming` order, rule 21); equal to `lastPushed` returns without a request. `hostUrl`, `hostToken` and `lifetime` are not in the key (constant per process).
18. Request: `PUT /v1/config` body `{revision: <revision+1>, hostUrl, hostToken, streaming, livetv?: <only when set>, pathMappings?: <only when non-empty>, lifetime}`. Non-2xx: `Error('PUT /v1/config -> <status>')` thrown and `revision`/`lastPushed` untouched (so the same revision is retried by the next push); 2xx: `revision++`, `lastPushed = key`, log `config pushed (revision N)`. Engine: 409 on a lower revision; the first push is needed before sessions/decide (400 before). `[engine:PROTOCOL.md:26]` `[engine:PROTOCOL.md:31]` `[engine:PROTOCOL.md:32]` A 409 refetches the revision from `GET /v1/config` and retries (5 attempts, 100 ms doubling); other statuses fail as above and the poll retries the push while `lastPushed` is unset.
19. `hostUrl()` = env `FLIKS_HOST_URL` when non-empty, else `http://127.0.0.1:` + (`Number(PORT) || 4848`). `hostToken` = 32 random bytes as 64 hex chars, regenerated at every process start, presented by the engine as the resolver bearer.
20. Push triggers (all through `pushStreaming`, deduped): (a) `HostHardwareService.load` at boot and on every `onConnect` (settings loaded first, then push, then GPU detection); (b) any `streaming_*` setting change while the engine is enabled; (c) every playback-info call through `hardware.apply`. `pushLivetv`: any of the 5 `livetv_*` keys changing, and once after `whenReady`; the in-memory `livetv` is re-sent with every later streaming push (an engine restart re-sends it too, with `lastPushed` cleared by adopt).
21. `toEngineStreaming` forwards exactly 12 fields: `segmentDuration, qsvPreset, tonemapAlgo, tonemapCurve, cacheMaxBytes, cacheTtlMs, ffmpegSlots, autoQualityMode, autoCropEnabled, gpuRenderNode, throttleEnabled, throttleThresholdSeconds`. The engine also has `jobMinFreeBytes` and `subtitlePrewarm` (defaults 1 GiB and `playback` apply because the host never sends them) and its `StreamingConfig` is `camelCase` with serde defaults. `[engine:crates/core/src/api.rs:127-153]`
22. `lifetime` (env-tuned, read lazily at each push) has exactly 7 keys: `liveSessionTtlMs` (env `STREAM_LIVE_SESSION_TTL_MS`, 30 000), `liveSessionGcIntervalMs` (`STREAM_LIVE_SESSION_GC_INTERVAL_MS`, 5 000), `sessionReviveTtlMs` (`STREAM_SESSION_REVIVE_TTL_MS`, 900 000), `maxSessionsPerOwner` (`STREAM_MAX_SESSIONS_PER_USER`, 10), `jobGraceMs` (`STREAM_JOB_GRACE_MS`, 60 000), `jobFallbackTimeoutMs` (`STREAM_JOB_FALLBACK_TIMEOUT_MS`, 1 800 000), `cacheGcIntervalMs` (`TRANSCODE_CACHE_GC_INTERVAL_MS`, 300 000). Env parsing: `parseInt(raw, 10)`, accepted only when finite and `> 0`, else the default. `pinnedSessionTtlMs` is not sent. `[engine:crates/core/src/api/lifetime.rs:23-45]`
23. `livetv` object (set by `pushLivetv`): `{segmentSeconds: max(1, intOr(raw, 2)), timeshiftMinutes: max(1, intOr(raw, 15)), probeSeconds: intOr(raw, 3), channelIdleSeconds: intOr(raw, 30), fastZap: 'true' -> true, 'false' -> false, else null}` where `intOr` = `parseInt(raw, 10)` if finite else the default (so `channelIdleSeconds` and `probeSeconds` are not floored here; the engine floors). `fastZap` is sent as JSON `null` when unset. `[engine:crates/core/src/api/live.rs:21-33]`
24. Streaming settings assembly (`StreamingSettingsCache.load`, 12 keys read in parallel): `segmentDuration = parseFloat(raw ?? '3') || 3`; `qsvPreset = raw ?? 'faster'` (not validated); `tonemapAlgo` in `auto|opencl|vaapi|qsv` else `auto`; `tonemapCurve` in `hable|mobius|reinhard` else `mobius`; `cacheMaxBytes = round(gb * 1024^3)` when `positive(raw)` else 21 474 836 480 (20 GiB); `cacheTtlMs = round(hours * 3 600 000)` when `positive(raw)` else 14 400 000 (4 h); `ffmpegSlots = positive(raw)` else `null`; `autoQualityMode` in `directplay|abr` else `directplay`; `autoCropEnabled = raw !== 'false'`; `gpuRenderNode = raw?.trim() || 'auto'`; `throttleEnabled = raw !== 'false'`; `throttleThresholdSeconds = max(60, positive(raw) ?? 90)`. `positive(raw)` = `Number(raw)` finite and `> 0`, else null (so null/`''`/`0`/`abc` mean "unset"; `Number('2.5')` passes as 2.5). `qsvPreset` outside the engine enum and a non-integer or above-`u32` `ffmpegSlots` take the default when read, and `streaming_qsv_preset` / `streaming_ffmpeg_slots` are refused with a 400 by the settings PUT (`engine::validate_streaming_setting`).
25. Cache behaviour: first `get()` loads and memoizes (concurrent callers share one in-flight load); any change of a key starting `streaming_` clears the cache and bumps an epoch so an in-flight load started before the change is not stored; `segmentDuration` is mirrored synchronously for other readers.

### D. Engine calls

26. Every call except hello/poll goes through `need()`: no adopted client answers 503 `The streaming engine is not running` (body `{statusCode:503, message, error:'Service Unavailable'}`).
27. Calls (method -> engine endpoint, error shape):

| Method | Engine call | Result / errors | Tags |
|---|---|---|---|
| `capabilities()` | `GET /v1/capabilities`; 503 retried after `Retry-After` seconds (`> 0` else 1 s) until a 5 min deadline | `Capabilities`; other status or deadline: `Error('GET /v1/capabilities -> <status>')` | `[engine:PROTOCOL.md:27]` |
| `capabilitiesFor(node)` | repeats `capabilities()` until `defaultGpu === want` (want = trimmed node, `auto`/empty meaning `/dev/dri/renderD128`) or no GPUs; 1 s between; 5 min deadline then warn `capabilities still on X after pinning Y` and return the last | `Capabilities` | `[engine:PROTOCOL.md:30]` |
| `probe(path, {crop,mkvTags,moviehash})` | `POST /v1/probe {media:{mediaFileId:0, path},...opts}` | `ProbeResult`; no data: `Error('POST /v1/probe -> <status>')` | `[engine:PROTOCOL.md:29]` |
| `estimateSizes(info, fileSize)` | `POST /v1/estimate-sizes {info: info ?? {}, fileSize}` | `QualityEstimate[]`; else `EngineError(status, 'POST /v1/estimate-sizes')` | `[engine:PROTOCOL.md:28]` |
| `invalidate(mediaFileId)` | `POST /v1/invalidate {mediaFileId}`; best effort (warn, never throws; no-op without a client) | none | `[engine:PROTOCOL.md:37]` |
| `openSession(body)` | `POST /v1/sessions`; 503 retried after `Retry-After` (`Number(h) \|\| 1` seconds) until a 15 s deadline | `OpenSessionResponse`; else `EngineError(status, 'POST /v1/sessions')` | `[engine:PROTOCOL.md:32]` |
| `openLive(body)` | needs feature `live` else 503 `The engine has no live TV runtime`; `POST /v1/live`; 503 **without** a body `code` retried like `openSession` | `OpenLiveResponse`; else `EngineError(status, 'POST /v1/live', code)` (`live_at_capacity` 409, `live_unavailable` 503) | `[engine:PROTOCOL.md:42]` |
| `listLive(ownerId?)` | `GET /v1/live[?ownerId]` | `LiveSnapshot[]`; else `EngineError` | |
| `heartbeat(sid, body)` | `POST /v1/sessions/{sid}/heartbeat` | `{sessionLost}`; else `EngineError(status, 'POST heartbeat')` (403 other owner) | `[engine:PROTOCOL.md:33]` |
| `deleteSession(sid, reason?)` | `DELETE /v1/sessions/{sid}[?reason]` | void; non-2xx `EngineError(status, 'DELETE session')` | `[engine:PROTOCOL.md:34]` |
| `sessionCommand(sid, action)` | `POST /v1/sessions/{sid}/command {action}` | HTTP status number (204/404/409) | `[engine:PROTOCOL.md:34]` |
| `listSessions({ownerId?, mediaFileId?})` | `GET /v1/sessions` | `SessionSnapshot[]` | `[engine:PROTOCOL.md:35]` |
| `getSession(sid)` | `GET /v1/sessions/{sid}` | snapshot, `null` on 404 | `[engine:PROTOCOL.md:35]` |
| `cache()` / `purgeCache({mediaFileId?, ownerId?})` | `GET /v1/cache` / `DELETE /v1/cache` | summary / removed count | `[engine:PROTOCOL.md:38]` |
| `introDetect(body)` | `POST /v1/intro-detect` | response; else `EngineError` | `[engine:PROTOCOL.md:43]` |
| `submitJob` / `cancelJob` / `getJob` | `POST /v1/jobs` -> `jobId`; `DELETE /v1/jobs/{id}` (404 tolerated); `GET /v1/jobs/{id}` (`null` on 404) | | `[engine:PROTOCOL.md:41]` |

28. Path mappings: `engine_path_mappings` JSON text parsed to `{from, to}[]` (each trimmed, entries with a non-string or blank side dropped, anything not an array or invalid JSON gives `[]`); loaded with the other two engine settings at init/reconfigure only (a change through any other path is not seen until then); the engine applies the longest prefix on a path boundary. `[engine:PROTOCOL.md:26]` `[engine:crates/core/src/api.rs:178-183]`
29. `revokeOwner(ownerId)`: no-op without a client or without feature `revoke`; `POST /v1/revoke {ownerId: String(ownerId)}`; non-2xx logs `POST /v1/revoke -> <status>`, a throw logs `POST /v1/revoke failed: <err>`; never throws (the resolver's 60 s TTL bounds a miss). Callers: user update when `enabled === false` or role/admin changes or `libraryIds` given, and user removal; users dropped from a library's access list; a live-TV restricted-group grant. `[engine:PROTOCOL.md:36]`

### E. Background jobs (`runJob`)

30. `runJob(req, onProgress?)`: `submitJob` (an identical queued/running request returns the same `jobId`), register a waiter `{resolve, reject, onProgress}` under that id (several waiters may share it), then `checkJob(jobId)` once (the job may have ended before registration), then await. Resolution `{state, result, error}`; `state !== 'done'` or no `result` rejects with `JobError` whose message is `engine job <state>: <error ?? req.kind.type>`. There is no timeout on the wait. `[engine:PROTOCOL.md:41]`
31. `checkJob`: `GET /v1/jobs/{id}`; 404 rejects every waiter with `Error('engine lost job <id>')` and removes them; state `done|failed|cancelled` settles waiters with the snapshot; any other state or a thrown error leaves them (the next resync retries).
32. Fed by the events follower: `BgJobProgress{jobId, pct}` calls every waiter's `onProgress(pct)`; `BgJobDone` (the event itself is the `{state, result?, error?}`) settles and removes the waiters. After every events (re)connect `resyncJobs()` runs `checkJob` for every pending id.
33. Job kinds: `Sprite`, `Scan`, `SubtitleExtract`, `Fingerprint`, `SubtitleSync`, `SubtitleOcr`, `SubtitleToSrt`; request shapes in the engine protocol. `[engine:PROTOCOL.md:41]`

### F. Resolver (`POST /engine/resolve`)

34. `EngineHostGuard`: `sha256(header ?? '')` compared with `sha256('Bearer ' + hostToken)` via `timingSafeEqual`; mismatch or missing header: 401 `{"statusCode":401,"message":"Unauthorized"}`. `[engine:PROTOCOL.md:48]`
35. Body validation (global body validation: whitelist + forbidNonWhitelisted + transform): `mediaId` present (any type), `credential` string, `purpose` in `stream|download|sprite|subtitle|live`, `subtitleId` and `streamIndex` optional ints `>= 0`. Any other field, or a failure: 400 (the engine treats non-2xx as a host fault and never caches it). `[engine:PROTOCOL.md:60]`
36. Flow: resolve the user from `credential`; none: `{allow:false, ttlS:60}` (HTTP 200). Else locate; success: `{allow:true, ownerId:String(user.id), ttlS:60,...found}` (`found` may override `ttlS` and add `path`/`format`); a thrown `HttpException` (404/400/403 from the checks) is a denial `{allow:false, ttlS:60}`; any other error propagates as a 5xx. Key order of the allow object: `allow, ownerId, ttlS, path?, format?`. `[engine:PROTOCOL.md:60]`
37. Credential parsing (`tokenOf`): trimmed; `^Bearer\s+(\S+)$` (case-insensitive) yields the token; else if it contains `=` it is a cookie header and the `fliks_access` cookie value is used; else the whole string is the token. Empty result: denial. `[engine:PROTOCOL.md:54]`
38. User check mirrors the access-token extractor: `jwt.verify(token)` (signature + expiry; an invalid token denies) then user by `payload.sub` with `enabled = true` and role loaded; none: denial. A token with a `scope` claim (`stream`, `cast`) is **accepted** (players carry stream tokens in URLs), except a live token (`live` claim, `livetv-sessions.md` rule 40), which only resolves `purpose: live` for its own sid (so the play `url` token dies with its viewer).
39. `purpose: 'live'` : `mediaId` is the live viewer's session id; unknown viewer: denial; the user must still be allowed to play the channel (`findPlayable`: channel exists and `enabled`, group not denied for the user); allow with `{ownerId, ttlS: 0}` and no path (re-checked on every request). `[engine:PROTOCOL.md:56]`
40. Other purposes: `mediaId` must be an integer `> 0` (else 400, i.e. denial). `purpose === 'subtitle'` with `subtitleId`: the subtitle row's media library ACL, then `path` = realpath of the stored file under the media root, `format` = lowercase extension without dot (`srt`, `ass`, `vtt`,...). Otherwise `resolveFile(id, user)` (rule 41) then: `sprite`: `path = <cacheDir>/thumbnails/<id>/sprite.jpg` (not checked on disk; `FLIKS_CACHE_DIR` or `<data>/cache`); `subtitle` with no `subtitleId`: needs `streamIndex` (else 400 denial), answers `{path: <media file>, format: 'embedded'}`; `stream`/`download`: `{path: <media file>}` (no `format`; the engine guesses from the extension). `[engine:PROTOCOL.md:57]` `[engine:PROTOCOL.md:58]` `[engine:PROTOCOL.md:59]`
41. `resolveFile(id, user)`: file with its media and library or 404; library ACL (`getAccessibleLibraryIds`: admin or `manage:all` gets every library id, else the user's `library_user_access` rows; a media whose `libraryId` is null or not in the list is a 404 for everyone, admins included); media without a root path 404; `absolutePath = resolve(media.path, relativePath)` must stay under `media.path` (404 `Invalid file path`), must exist (`stat`, 404) and its `realpath` must also stay under the root (symlink escape, 404). `media.path` = `library.path` joined with `folderName` (library root when no folder). All 404s are denials here.
42. Subtitle path under the media root: `path.resolve(root, stored.trim())` must start with the root (else not found); then `realpath` (missing: not found); no `realpath` containment check on subtitles (only the lexical one).
43. Engine caching contract the answers feed: cached per credential hash, `mediaId`, purpose, `subtitleId`, `streamIndex` for `ttlS`; denials too (60 s); 5xx never cached; resolver unreachable/5 s timeout: grants keep serving, else the engine answers 503 + `Retry-After: 2`. `[engine:PROTOCOL.md:62]`

### G. Remote-engine admin routes

44. `GET`: reads `engine_url`, `engine_token`, `engine_path_mappings` (settings), `url = value ?? ''`, `token = value ?? ''`, `pathMappings = parsePathMappings(raw)`, `status = engine.status`, `processUrl = env FLIKS_ENGINE_URL ?? ''`; `mismatch: true` only when the saved and process URLs differ; `error: 'The streaming engine is unreachable'` only when `status === 'down'`. Property order: `url, token, pathMappings, status, processUrl, mismatch?, error?`.
45. `token` is redacted with the redact/merge convention of `settings.md`, and a PUT carrying the placeholder keeps the stored token. Shape: `GET` omits `token` and carries `secretsSet: ["engine_token"]` only when one is saved (the `GET /api/settings` convention); `PUT` `token` blank or absent keeps the saved one, `null` clears it; `POST /api/engine/remote/test` takes `token` optional (blank or absent tests the saved or process token) and answers 201.
46. `PUT`: `pathMappings = sanitizePathMappings(dto.pathMappings)` (trim both sides, drop entries with a blank side); then three writes with `origin = OWN_MODULE_ORIGIN` in order `engine_url = dto.url` (as given, not trimmed), `engine_token = dto.token`, `engine_path_mappings = JSON.stringify(list)` or `null` when empty (each write runs the settings change listeners and the `settings.changed` domain event; the generic settings API refuses these keys, `PROTECTED_KEYS`); then `engine.reconfigure()` (waits for the handshake: up to about 10 s of hello retries); returns the snapshot (rule 44).
47. `POST test`: rule 14.

### H. Events consumer (`GET /v1/events`)

48. Follower lifecycle: starts after `whenReady()` and on every `onConnect` (adopt with `notify`); `restart()` always aborts the previous follower first and starts a new one only if `engine.runtime`.
49. Loop per connection: `GET /v1/events` (rule 4); non-2xx or no body: `Error('GET /v1/events -> <status>')`. **Subscribed before listing**: only after the response headers arrive does it run `resync()` (`GET /v1/sessions` and the rest of rule 54), so an event between the two is replayed rather than lost; then it reads frames. The 45 000 ms idle watchdog (`IDLE_MS`; the engine pings every 15 s) is armed when headers arrive and re-armed on every received chunk (keep-alive comments included); expiry aborts the connection. Any exception (HTTP error, resync failure, watchdog abort) logs `engine events: <message>` (unless the follower was stopped) and reconnects; a frame that is not JSON logs `engine events: frame skipped: <error>` and the connection goes on. `[engine:PROTOCOL.md:39]`
50. Backoff between connections: starts at 500 ms, `sleep(backoff)` then `backoff = min(backoff*2, 15000)`, so a normal stream end also waits; reset to 500 only after a successful resync (not on HTTP 200 alone). The sleep is cancelled by stopping the follower.
51. SSE parsing (`sseData`): blocks end at a blank line (`\r?\n\r?\n`, chunk boundaries irrelevant); a block's payload = its `data:` lines (one leading space stripped), joined with `\n`; blocks without `data:` (comments, `event:` only) yield nothing; the `onBytes` hook fires for every chunk. The SSE `event:` name is ignored (the JSON carries `type`). `[engine:PROTOCOL.md:39]`
52. Dispatch (`handle`): every registered `onEvent` listener first (live TV), then by `type`: `SessionOpened`, `SessionEnded`, `PipelineChanged`, `SegmentServed` feed presence/QoE (`presence.md`, `qoe.md`); `JobStarted{jobKey}` / `JobEnded{jobKey}` add/remove from the running-job set (`activeJobs`, QoE load probe); `BgJobProgress`/`BgJobDone` go to the engine service waiters (rule 32). Unknown types are ignored (protocol rule: readers ignore unknown variants). `[engine:PROTOCOL.md:17]` `[engine:crates/core/src/api/runtime.rs:355-430]`
53. Engine event types and payloads the host reads (camelCase, tag `type`): `SessionOpened{session: SessionSnapshot}`, `SessionEnded{sessionId, reason}`, `PipelineChanged{sessionId, quality, hwAccel}`, `SegmentServed{sessionId, track, rung, index, waitedMs, cacheHit, cmcdRaw?}`, `JobStarted{jobKey, mediaFileId, quality, startSegment, hwAccel}`, `JobEnded{jobKey, state, exitCode?, reason?}`, `HwFallback{jobKey, from, to, stderrTail}` (ignored by the host), `BgJobProgress{jobId, pct}`, `BgJobDone{jobId, state, result?, error?}`, `LiveAttempt`, `LiveReleased` (consumed by live TV). `[engine:crates/core/src/api/runtime.rs:355-430]`
54. `resync()`: `GET /v1/sessions`; presence restored for sessions the registry does not know; presence for a session the engine does not hold is stopped unless it started after the list was taken; the running-job set is rebuilt from sessions whose `job.state === 'running'` using key `<mediaFileId>-u<ownerId>|anon-<profileHash>`; then `engine.resyncJobs()` and every registered `onResync` listener (live TV) run. Detail of presence in `presence.md`. `[engine:PROTOCOL.md:35]` `[engine:PROTOCOL.md:39]`

## SQL

Resolver (equivalent SQL):

1. User: `SELECT u.*, r.* FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.id = $1 AND u.enabled = true;` (`$1` = JWT `sub`).
2. File: `SELECT mf.*, m.*, l.* FROM media_files mf LEFT JOIN media m ON m.id = mf."mediaId" LEFT JOIN libraries l ON l.id = m."libraryId" WHERE mf.id = $1;`
3. Accessible libraries: admins / `manage:all`: `SELECT id FROM libraries;` else `SELECT "libraryId" FROM library_user_access WHERE "userId" = $1;`
4. Subtitle: `SELECT sf.*, m.*, l.* FROM subtitle_files sf LEFT JOIN media m ON m.id = sf."mediaId" LEFT JOIN libraries l ON l.id = m."libraryId" WHERE sf.id = $1;`
5. Live channel check: `SELECT c.* FROM livetv_channels c WHERE c.id = $1 AND c.enabled = true` plus its streams and their source rows (relations `streams`, `streams.source`; join tables per the live TV spec) and the user's denied groups.
6. Settings reads (`engine_*`, `streaming_*`, `livetv_*`): `SELECT value FROM app_settings WHERE key = $1;` one query per key.

## Events

No SSE or domain event is emitted by this domain except the `settings.changed` domain events caused by the three `settings.set` calls of `PUT /api/engine/remote` (rule 46). Consumed: the engine's `/v1/events` stream (rules 49-53); the `streaming_` / `livetv_` settings change listeners (rules 20, 25).

## Settings keys

| Key | Default | Parsing |
|---|---|---|
| `engine_url` | `''` (env `FLIKS_ENGINE_URL` stands) | trimmed, non-empty wins |
| `engine_token` | `''` (env `FLIKS_ENGINE_TOKEN` stands) | trimmed, non-empty wins |
| `engine_path_mappings` | none (no mappings) | JSON `{from,to}[]` (rule 28) |
| `streaming_segment_duration` | 3 | rule 24 |
| `streaming_qsv_preset` | `faster` | raw string |
| `streaming_tonemap_algo` | `auto` | enum |
| `streaming_tonemap_curve` | `mobius` | enum |
| `streaming_cache_max_gb` | 20 GiB | positive float |
| `streaming_cache_ttl_hours` | 4 h | positive float |
| `streaming_ffmpeg_slots` | null | positive number |
| `streaming_auto_quality_mode` | `directplay` | enum |
| `streaming_auto_crop_enabled` | true | `!== 'false'` |
| `streaming_gpu_render_node` | `auto` | trimmed or `auto` |
| `streaming_throttle_enabled` | true | `!== 'false'` |
| `streaming_throttle_threshold_seconds` | 90 (floor 60) | positive number |
| `livetv_segment_seconds` / `_timeshift_minutes` / `_probe_seconds` / `_channel_idle_seconds` / `_fast_zap` | 2 / 15 / 3 / 30 / unset | rule 23 |

Env: `FLIKS_ENGINE_URL`, `FLIKS_ENGINE_TOKEN`, `FLIKS_HOST_URL`, `PORT`, `FLIKS_CACHE_DIR`, `STREAM_LIVE_SESSION_TTL_MS`, `STREAM_LIVE_SESSION_GC_INTERVAL_MS`, `STREAM_SESSION_REVIVE_TTL_MS`, `STREAM_MAX_SESSIONS_PER_USER`, `STREAM_JOB_GRACE_MS`, `STREAM_JOB_FALLBACK_TIMEOUT_MS`, `TRANSCODE_CACHE_GC_INTERVAL_MS` (see `config.md`).

## Jobs/timers

| Timer | Value |
|---|---|
| hello handshake | 20 x 500 ms |
| hello poll | 10 000 ms; backoff while down 500 -> 10 000 |
| events idle watchdog | 45 000 ms |
| events reconnect backoff | 500 -> 15 000 ms |
| capabilities 503 retry | `Retry-After` s, deadline 5 min |
| open session/live 503 retry | `Retry-After` s, deadline 15 s |
| resolver answer TTL | 60 s (live 0) |
| `capabilitiesFor` repin poll | 1 s, deadline 5 min |

## Vectors/parity

Rust tests against a fake engine (axum test server) cover: hello gating, background connection, config push, capabilities, probe, host callback, revoke, runtime and session calls, remote config, jobs, the engine client, the resolver (table tests: credential forms x purposes x ACL) and the events follower, `sseData` and job cases (the `handle`/`resync` presence cases are in `presence.md`). Further cases: a 409 on a lower config revision refetches the revision and retries (rule 18), a refusal does not stop polling (rule 9), the idle watchdog of 45 s with a paused clock (rule 49), backoff reset only after resync (rule 50).

Fixture sets: none. HTTP parity scenarios (`server/parity/scenarios/engine/`): `engine-remote-get`, `engine-remote-get-forbidden` (403 non-admin, 401 anon), `engine-remote-put-validation` (400), `engine-remote-test-unreachable` (200 `{ok:false,...}` against a closed port), `engine-resolve-denied-bad-token` (401), `engine-resolve-allow-stream`, `engine-resolve-deny-unknown-user`, `engine-resolve-subtitle-embedded`; the resolver scenarios use the runner's `as: "engine"` credential (the per-boot host token, `PARITY_HOST_TOKEN`, read from the engine's `GET /v1/config`).
