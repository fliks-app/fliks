# Spec: playback-info and streaming control plane

Out of scope here: `LiveSessionRegistry` internals and `engine-events.service.ts` (presence/engine glue), the SSE hub, remote control, `PUT /api/playback/media/:id/state` (`heartbeat.md`), QoE (`qoe.md`). Where this file needs them it states the observable behaviour only.

Golden parity source: `server/fixtures/playback-info/engine-playback.recorded.json`. Top-level keys `engine` (the engine's `POST /v1/sessions` answer: `sessionId, profileHash, playPath, decision{response,useHdrLadder,audioPlans,muxFlavour,transcodeTonemapping,videoVariant}, hints, playbackClockOffsetS, qoePipeline`) and `host` (the playback-info body expected for it: web device, 1280x720 h264/aac mkv, `startQuality=360p`). The Rust test feeds `engine` through a fake engine and asserts the body equals `host` (same setup as the first case of: user id 1 `edlEnabled:true`, query `tokenParam:'?token=tok'`, `startQuality:'360p'`, `sseConnectionId:'conn-9'`, `userAgent:'livecheck/1.0'`, file id 1 / media id 5 / no episode, no sidecar, no saved state).

## Routes

Every route here is under `/api/stream` and takes `JwtOrApiKeyGuard`; none takes `PoliciesGuard` or `SessionTokenGuard` (a `scope:'stream'` token is accepted on every route here). The engine serves every other `GET /api/stream/:id/**` byte route.

`:mediaFileId` must be a numeric string: non-numeric -> 400 `{statusCode:400, message:"Validation failed (numeric string is expected)", error:"Bad Request"}`.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `POST /api/stream/:mediaFileId/playback-info` | `JwtOrApiKeyGuard`; policies none | body `DeviceProfileDto` (below); query `burnInSubtitleId`, `startAt`, `audioStreamIndex`, `startQuality`, `download` (`'1'` = true), `preRollFirst` (`'1'` = true, rule 20), `token`, `sid`; headers `x-fliks-sse-connection`, `user-agent` | `EnginePlaybackInfo` JSON (rule 23) | 400 DTO validation; 400 `err.message` when the engine answers 400; 404 file/ACL; 503 engine states (rules 4, 5, 14) | opens an engine session, creates presence, registers QoE, may schedule re-probe/scan, writes `playback_states` row (rules 4-23) |
| `GET /api/stream/info/qualities/:mediaFileId` | `JwtOrApiKeyGuard`; none | param only | engine `POST /v1/estimate-sizes` array `QualityEstimate[]`, verbatim | 404 (resolveFile); 503 `The streaming engine is not running` (no engine client) | none |
| `GET /api/stream/info/hw-accel` | `JwtOrApiKeyGuard`; none | - | `{ hwAccel: string }` | - | none |
| `GET /api/stream/info/tonemap-algos` | `JwtOrApiKeyGuard`; none | - | `{ available: string[] }` | - | none |
| `GET /api/stream/info/effective-settings` | `JwtOrApiKeyGuard`; none | - | `{ tonemapAlgo, gpuRenderNode, tonemapCurve, cacheMaxGb:number, cacheTtlHours:number, ffmpegSlots:number\|null, ffmpegSlotsAuto:number, pauseCapability:string }` | - | none |
| `GET /api/stream/info/gpus` | `JwtOrApiKeyGuard`; none | - | `{ gpus: {renderNode,label,kind:'unknown'}[], defaultNode:string }` | - | none |
| `GET /api/stream/:mediaFileId/edl` | `JwtOrApiKeyGuard`; none | param only | `{ ranges: {start:number,end:number,action:'cut'\|'mute'\|'commercial'}[] }` | 404 (resolveFile) | none |
| `DELETE /api/stream/sessions/:sessionId` | `JwtOrApiKeyGuard`; none | param `sessionId` string (no pipe) | 204, empty body, also for an unknown sid | 403 `{message:"Not your session"}` | presence stop, QoE flush, `remote.stopped`/`remote.targets_changed`, engine `DELETE /v1/sessions/{sid}` (rule 28) |
| `GET /api/system/streams` | `JwtOrApiKeyGuard`, `PoliciesGuard`; `ability.can(Action.Read, 'Settings')` | - | `ActiveStreamDto[]` (rule 33) | 401/403 | engine `GET /v1/sessions` (read) |
| `POST /api/system/streams/:sessionId/command` | same guards; `ability.can(Action.Manage, 'Settings')` | body `{action:'pause'\|'play'\|'stop'\|'message', message?:string}` (an `action` outside those four is 400) | `{ ok: true }` | 400 `Session not found` (unknown sid, or presence has `userId == null`) | `player.command` SSE event; on `stop` presence stop + engine delete (rule 35) |
| `GET /api/system/transcode-cache` | same guards; `Read Settings` | - | `{ entries:number, bytes:number }` | - | engine `GET /v1/cache` |
| `DELETE /api/system/transcode-cache` | same guards; `Manage Settings` | - | `{ ok:true, entries:number, bytes:number }` | - | engine `GET /v1/cache` then `DELETE /v1/cache` |
| `DELETE /api/system/transcode-cache/:mediaFileId` | same guards; `Manage Settings` | param numeric; query `userId` | `{ ok:true, entries, bytes }` | 400 pipe | same as above, filtered |

`DeviceProfileDto` (unknown properties, nested ones included, are stripped silently, never rejected):

| field | type / constraint | required |
|---|---|---|
| `directPlayProfiles` | `{containers:string[], videoCodecs:string[], audioCodecs:string[]}[]` (each nested validated) | **yes** (array) |
| `codecConditions` | `{codec:string, maxLevel?:number, profiles?:string[], maxBitDepth?:number, maxWidth?:number, maxHeight?:number}[]` | no |
| `maxStreamingBitrate`, `maxAudioChannels` | number | no |
| `audioChannelsByCodec` | object (`Record<string,number>`, values not checked) | no |
| `supportsHdr`, `tonemapsHdrLocally`, `cropsBlackBarsLocally`, `supportsDolbyVision`, `supportsDirectPlay`, `switchesDirectPlayAudio`, `supportsHlsSubtitles`, `dedupesAudioByLanguage`, `supportsMuxedAudioRendition`, `supportsIFrameTrickPlay`, `supportsImageSubtitles`, `probesSegZero`, `useTs`, `useTsOnSingleAudio`, `supportsAbr`, `rejectCopy`, `needsHlsSubtitles` | boolean | no |
| `dolbyVisionProfiles` | int[] | no |
| `deviceType` | `'mobile'\|'desktop'` | no |
| `deviceName` | string | no |
| `systemName` | string, max 60 | no |
| `appVersion` | string, max 40 | no |

Validation failure -> 400 `{statusCode:400, message:string[], error:"Bad Request"}` (validator messages; parity compares `statusCode`+`error` only).

## Rules

### Playback-info: request parsing

1. Query parsing in the controller: `burnInSubtitleId` = `parseInt(first value,10)` when the string is non-empty, else `undefined`; `startAt` = `parseFloat(v)` when the query key is present (including `''`), else `undefined`; `download` is `true` only for the exact string `'1'`; `audioStreamIndex` and `startQuality` are passed as the raw first string value; "first value" = the string, or the first element when the key repeats. A non-numeric `startAt` yields `NaN` (not rejected; serialised `null` into the engine request and the presence).
2. `tokenParam` = `'?' + parts.join('&')` over the keys `token` then `sid` (only those present and non-empty), each `key=encodeURIComponent(firstValue)`; `''` when none. It is carried into the URLs the engine builds.
3. `sseConnectionId` = header `x-fliks-sse-connection` or `null`; `userAgent` = header `user-agent` or `null`.

### Playback-info: the 15 steps (numbering is this spec's; order is the code's)

4. **Step 1 gateway guard.** `engine.gatewayMismatch` (saved engine URL differs from `FLIKS_ENGINE_URL`) -> 503 `The saved engine URL is not the one this process forwards video to`. Evaluated before anything else.
5. **Step 2 runtime guard.** `!engine.runtime` (no adopted engine with features `sessions`,`serve`,`events`) -> 503 `The streaming engine is unreachable` when `engine.status === 'down'`, else 503 `Playback needs the streaming engine, which is not running`.
6. **Step 3 resolve file** (rules 38-39). 404 propagates. `info = mediaFile.streamInfo` (jsonb, may be null).
7. **Step 4 burn-in.** `burnInSubtitleId` falsy (0, NaN, absent) -> no burn-in. Otherwise `SubtitleBurnInService.resolve` then `buildFilter`; **any** throw (404 subtitle, file missing, DB) is logged `warn` and the playback proceeds without burn-in (never an error response). Result `{filter: string|null, streamIndex?, type:'text'|'image'}`. Resolve and filter rules: 42-44.
8. **Step 5 hardware.** `await hardware.apply(await settingsCache.get())` on every call (rule 47). A rejection of `settingsCache.get()` (DB) is not caught -> 500.
9. **Step 6 scan lookup.** `sourceScans.lookup(mediaFileId, absolutePath, info)` -> `{scan: SourceScan|null, version: string|null}` (rule 48). Never throws. It may mutate `info.timestampBreakSeconds` in place and update the DB row.
10. **Step 7 start position** (returned as `startAtSeconds`, so clients need no resume rule of their own; the scan lookup, the position, the markers/pre-roll/EDL reads and the engine open run concurrently, `mark_started` follows a successful open). `position = startAt` when `startAt !== undefined` (so `0` restarts, `NaN` passes through); else `getState(userId, mediaFile.mediaId, episodeId)` and, when a row exists, `!completed` and `positionSeconds > 10`, use its `positionSeconds`; else `0`. `episodeId = mediaFile.episodeId ?? undefined`. DB errors -> 500.
11. **Step 8 subtitle renditions.** Only when `device.supportsHlsSubtitles` is truthy: `listTextSubtitleRenditions(mediaFileId, user)` (rule 45); any failure -> `undefined` (swallowed, silently).
12. **Step 9 attribution, tags, client.** `attributionTarget = events.targetIdFor(sseConnectionId)`; `attributedUserId = events.takeAttribution(attributionTarget, mediaFileId)` (consumes the claim; claim valid 60 s and only for the same file id:). `tags` = string map of `{username, mediaTitle, mediaType, posterUrl, fanartUrl, sseConnectionId, attributedUserId}` with every `null`/`undefined`/`''` entry dropped and values `String()`-ed (`username` = `user.username`; media fields from `resolved.media`). `client = {deviceName, systemName, appVersion (from the DTO), userAgent: header ?? undefined}`.
13. **Step 10 open.** `engine.openSession(OpenSessionRequest)` = `POST /v1/sessions` with body:
    `{ decide: { media: {mediaFileId, path: absolutePath, ext, contentType}, info, scan: held.scan, device: <DTO as received after whitelist>, selection: { tokenParam, burnInSubtitleId: burnIn ? q.burnInSubtitleId: undefined, burnInIsText: !!burnIn?.filter, requestedQuality: q.startQuality, audioStreamIndex: resolveAudioStreamIndex(q.audioStreamIndex, info?.audio?.length ?? 0) } }, ownerId: String(user.id), client, tags, startAtS: position, pinned: q.download, burnIn: burnIn && {type, filter: filter ?? undefined, streamIndex}, sourceVersion: held.version ?? undefined, subtitleRenditions }`.
    `resolveAudioStreamIndex`: `Number(raw)` must be an integer in `[0, audioCount)`, else `undefined` (first track). The engine client retries 503 + `Retry-After` (default 1 s) until 15 s elapse, then throws `EngineError(503)`.
14. **Open error mapping.** `EngineError` with status 400 -> 400 with `err.message` where `err.message` = `POST /v1/sessions -> 400`; any HTTP error is rethrown as is; every other error -> warn log + 503 `The streaming engine is unavailable`. On any failure, when `attributionTarget` and `attributedUserId != null`, the claim is given back (`claimAttribution(target, userId, mediaFileId)`) before rethrowing.
15. **Step 11 presence.** `kind = 'directplay'` if `response.playMethod === 'DirectPlay'`, `'remux'` if `'DirectStream'`, else `'transcode'`. `liveSessions.create(presenceInput(...))` keyed by the engine `sessionId`, with `position`, `quality = q.startQuality ?? null` (the *requested* quality, not the engine's), `profileHash = open.profileHash ?? null`, fields per `presenceInput` (`deviceLabel = client.userAgent ?? null`, `bitrateByQuality = response.transcodeBitrateByQuality ?? null`, `hdrLadder = decision.useHdrLadder`, `clientTonemap`, `transcodeReasons`, `audioPlan`, `sourceFps = parseSourceFps(response.source.frameRate)`, `attributedUserId` = `Number(tags.attributedUserId)` if integer else null). New presence: `state:'playing'`, `startedAt = lastBeat = now`, defaults per `buildLiveSession`.
16. **Step 12 QoE.** `qoe.register(live)`; if `open.qoePipeline` is present, `qoe.setPipeline(live, toQoePipeline(open.qoePipeline))` where absent members become explicit `null` (`source, decode, encode, tonemap, burnIn, crop, audioTranscode` default `null`; `output` null or its five fields defaulted to `null`).
17. **Step 13 rescan hint** (fire and forget, `void`, never awaited, never affects the response): `open.hints.probeStale` -> `staleProbeRescan.schedule(mediaFileId, absolutePath)`; else `open.hints.scanMissing` -> `sourceScans.scheduleIfNeeded(mediaFileId, absolutePath, info, 'high')`.
18. **Step 14 extras in parallel** (run concurrently, started in this order): markers (rule 19), pre-roll (rule 20), EDL sidecar (rule 21), `markSessionStarted` (rule 22). `fps = parseSourceFps(info.video[0].frameRate)` (decimal or `a/b` rational; `undefined` when unknown). **Failure isolation:** only the markers query can reject (the other three never reject: pre-roll `ask` swallows plugin failures, EDL read returns `null`, `markSessionStarted` is `.catch`-ed with a `warn`); a markers DB error therefore yields 500 **after** the engine session was opened and presence + QoE tracker were created (no rollback; the engine reaps the session by TTL).
19. **Markers.** Only when `episodeId` is truthy (movies: `undefined`). Two reads, concurrent: `findIntroForEpisode`, `findOutroForEpisode` (SQL below). Result `{ intro: {startSeconds,endSeconds}|undefined, outro:... }` only if at least one exists, else `undefined`; an absent side is `undefined`, i.e. the key is omitted in JSON. `recap` markers are never read here.
20. **Pre-roll.** `PluginPreRollService.ask({mediaFileId, mediaId, episodeId, principal:{kind:'delegated', userId}})`. Never throws: no declaring plugin, plugin failure/timeout, non-200 or malformed body all answer `[]`; items are sanitised (positive integer `mediaFileId`, not the main file, no repeats, at most `PRE_ROLL_ITEMS_MAX`, optional `labelKey:string`, `skippable:boolean`). Then each candidate id is re-checked with `streamingService.resolveFile(id, user)` concurrently; only fulfilled candidates stay. Result `undefined` (key omitted) when empty, never `[]`. **`preRollFirst=1`** (a client about to play the items before the film): the pre-roll is read with step 7, and when it is non-empty and `position` is `0` the answer is `{deferred: true, preRoll}` with status 201, before any engine call: no session, presence, QoE or history row exists, and the client asks again for the film once its last item is done. Any other case (no item, a resume, the key absent) is the normal answer, reusing that read for `preRoll`.
21. **EDL.** Skipped (`undefined`) when `user.edlEnabled === false`; else `readEdlSidecar(absolutePath, fps)` (rules 40-41). In the response, `edl` = `shiftRanges(edl, open.playbackClockOffsetS ?? 0)` when the read yields a non-empty array, else key omitted.
22. **markSessionStarted** runs only when `!q.download && user.id && mediaFile.mediaId`: ensures a `playback_states` row exists and bumps `lastPlayedAt` (SQL below); never sets `playedAt`; the failure is swallowed with a warn. For an existing row only `mediaFileId` (the file being opened), `lastPlayedAt` and `updatedAt` change, so the detail page preselects that file even when the player closes before its first heartbeat. A download (`download=1`) never touches history.
23. **Step 15 response** = `{...engine.decision.response, playUrl: open.playPath, edl, tonemapAlgo: open.tonemapAlgo ?? null, tonemapCurve: open.tonemapCurve ?? undefined, durationSeconds: info?.durationSeconds ?? 0, startAtSeconds: position, markers, chapters: info?.chapters?.length ? info.chapters: undefined, preRoll, sessionId: open.sessionId, profileHash: open.profileHash ?? null }`, JSON-serialised (undefined keys omitted; `tonemapAlgo` and `profileHash` always present, `null` when unknown). `playUrl` carries the sid (`/api/stream/<id>/master.m3u8?sid=<sid>`) so it overrides `response.playUrl`. All other fields come from the engine decision and are frozen by the golden (`mediaFileId, playMethod, contentType, transcodeReasons[{flag,message}], videoCopyStream, audioCopyStream, outputVideoCodec, outputAudioCodec, audioPlan, outputContainer, quality, hwAccel, tonemapping, clientTonemap, dolbyVision, transcodeBitrateByQuality, remuxMasterBandwidthBps, qualities[QualityOption], audioTracks[AudioTrackPlan], source{...}`; shape = `PlaybackInfoResponse`).
23a. **Track markers** (additive after 5.0.0, #1763; `fliks_domain::track_markers`). Each `audioTracks[]` entry gains `trackMarkers` (string array, always present) and `title` (the source stream's title, absent when it has none), read from `info.audio[index]`; an index outside `info.audio` gives `trackMarkers: []` and no `title`. The same `trackMarkers` is added to every `streamInfo.audio[]`/`subtitles[]` entry of the media JSON (`media-query.md` rule 30). Derived at read time, in this order, from the stored stream:
    - audio: `hearingImpaired`, `commentary` (flag or title), `audioDescription` (flag or title), `original`, `dub`, `musicAndEffects` (`cleanEffects`), `karaoke`, `atmos` (`profile` contains `atmos`), `dtsX` (`profile` contains `dts:x`), case-insensitive;
    - subtitles: `forced` (flag, or title unless `non`/`not` precedes it), `hearingImpaired` (flag or title), `commentary` (flag or title), `descriptions`, `lyrics`;
    - titles match whole words, case-insensitive: commentary `commentary`, `commentaries`, `commentaire(s)`; audio description `audio description`/`audiodescription`/`audio described`, `description audio`, `AD`, `malvoyant(s)`; SDH `sdh`, `cc`, `sme`, `hearing impaired`, `closed caption(s)`, `sourds`, `malentendants`; forced `forced`, `forcé(s)`, `forcée(s)`. A title only adds a marker, it never drops a track.
    The flags are the engine probe's (`schemaVersion` 2 added `hearingImpaired`, `original`, `dub`, `cleanEffects`, `karaoke` on audio, `commentary`, `descriptions`, `lyrics` on subtitles). An older blob has none of them until it is re-probed: the engine hints `probeStale` for it (rule 17), so its next playback re-probes it (rule 51); titles and profiles are already stored, so their markers show at once.
24. The host decides nothing about play method, quality ladder or tonemap: those come from the engine's `decision.response`; the host never recomputes them.

### Other routes

25. `GET info/hw-accel` returns `{hwAccel}`; value = last engine capabilities `hwAccel`, `'none'` before any detection. `GET info/tonemap-algos` returns `{available}` = capabilities `tonemapAlgos`, default `['auto']`. `pauseCapability` default `'none'`.
26. `GET info/gpus`: `gpus` = capabilities `gpus` mapped `{renderNode: g.renderNode, label: g.name, kind: 'unknown'}` (empty list before detection); `defaultNode` = admin pin or `/dev/dri/renderD128`.
27. `GET info/effective-settings`: `cacheMaxGb = +(cacheMaxBytes / 1024**3).toFixed(1)`, `cacheTtlHours = +(cacheTtlMs / 3_600_000).toFixed(1)`, `ffmpegSlotsAuto = Math.max(1, os.availableParallelism() - 1)` (the engine does not report its figure), other fields straight from the settings cache (rule 46).
28. **`DELETE sessions/:sid`** order: (a) `live = peek(sid)`; `ownerId = live ? live.userId: engineOwnerOf(sid)` (engine `GET /v1/sessions/{sid}` `ownerId` as integer; `null` when no runtime, on any error, or non-integer); (b) if `ownerId != null && ownerId !== user?.id` the caller must hold `Manage Settings` (CASL, `createForUser(user)`), else warn + 403 `Not your session` (`attributedUserId` is **not** considered here, unlike the heartbeat); (c) if `live?.userId != null`: `targetId = events.targetIdFor(live.sseConnectionId)`; with a target emit `remote.stopped{targetId}` to `live.userId`, without a debug log only; then always emit `remote.targets_changed` to `live.userId`; (d) `liveSessions.stop(sid)` (triggers QoE `sessionEnded` flush when the presence existed); (e) if engine runtime: `engine.deleteSession(sid)` with failure only warned; (f) 204. Events are emitted before the stop; no step is wrapped except (e). Unknown sid with no owner: 204.
29. **`GET:id/edl`**: `resolveFile(id, user)` first (404), then `user.edlEnabled === false` -> `{ranges: []}`; else `fps` from `streamInfo.video[0].frameRate`; `ranges = readEdlSidecar(...) ?? []` on the container timeline (no shift, no clock offset).
30. **`GET info/qualities/:id`**: `resolveFile(id, user)`; `engine.estimateSizes(streamInfo, size)` -> `POST /v1/estimate-sizes {info: streamInfo ?? {}, fileSize: size}`; non-2xx -> `EngineError` (unmapped: 500).

### Presence-less helper behaviour used above

31. `LiveSessionRegistry.stop(sid)` calls `qoe.sessionEnded(session)` when the entry exists and returns whether it was known.

### Admin streams and cache

32. `GET /system/streams`: `engineSessions` = map of engine `GET /v1/sessions` by sid when `engine.runtime` and the call succeeds (failure -> warn, `null`); presence entries are kept when (engine map present) `engineSessions.has(sid)`, else `lastBeat > now - STREAM_LIVE_SESSION_TTL_MS` (default 30 000 ms).
33. `ActiveStreamDto` fields; derivations: `quality` = `'original'` for `directplay`, else `engine snapshot quality ?? presence quality ?? 'original'`; `hwAccel` = `'none'` for `directplay`/`remux`, else `eng.job.actualHw ?? host hwAccel`; `lastActivity` = engine `lastBeatMs` when known, else presence `lastBeat` (ISO strings); `positionSeconds` = presence `position` (memory, fresher than the debounced DB row); `durationSeconds` = `streamInfo.durationSeconds ?? 0`; `mediaId` = file's `mediaId ?? 0`; `episodeId` = file's `episodeId ?? null`; `container` = file extension without dot or null; `videoCodec`/`audioCodec` upper-cased first streams; `videoResolution` = for `transcode` with `quality !== 'original'` the quality, else `bucketResolutionLabel(w,h) ?? 'WxH'`; `audioChannels` = `channelLayout ?? '<n>ch'`; `outputContainer` `'HLS'` for transcode/remux else null; `outputBitrate` = served rung `videoBitrateBps` for transcode, `(video.bitRate ?? 0) + (audio.bitRate ?? 0) || null` for remux; audio output fields from `deriveAudioOutput`; `episodeLabel` = `S<season>:E<ep>` (+ ` - title`), `?` for a missing season; `transcodePercent`, `videoReasons`/`audioReasons`/`containerReasons` (messages of engine `transcodeReasons` whose `flag` starts with `Video`/`Audio`/`Container`) only for non-`directplay` sessions with an engine snapshot; `qoe` = `QoeService.liveSummary(sid)` or null; `engineStatus` = `off|up|down`; `job` = engine snapshot `job` or null.
34. Live TV rows are appended after on-demand rows, one per viewer from `LiveTvSessionService.listForActivity()` (engine `GET /v1/live`; `[]` on failure): `mediaType:'livetv'`, `mediaId = channelId`, `mediaFileId:0`, `mode = 'direct' -> 'directplay'`, `quality = sourceName ?? 'Live'`, `hwAccel` = host value, `job:null`.
35. `POST /system/streams/:sid/command`: no presence or `userId == null` -> 400 `Session not found`; emit `player.command{sessionId, mediaFileId, userId, action, message}` to the presence's `sseConnectionId` when `hasConnection(id)`, else to every connection of `live.userId` (clients filter on `sessionId`); for `action==='stop'` also `liveSessions.stop(sid)` and fire-and-forget `engine.deleteSession(sid)` (failure warned). Any other `action` value is emitted unvalidated. Always `{ok:true}`.
36. `GET /system/transcode-cache`: without engine runtime `{entries:0, bytes:0}`; else engine `GET /v1/cache` -> `{entries: entries.length, bytes: usedBytes}`.
37. Purge (`DELETE` both forms): without runtime `{ok:true, entries:0, bytes:0}`. Else read `GET /v1/cache`, `gone` = entries with `!live` and (`mediaFileId` filter equal, if any) and (`ownerId` equal, if any); then engine `DELETE /v1/cache?mediaFileId&ownerId`; answer `{ok:true, entries: gone.length, bytes: sum(gone.bytes)}` (computed from the pre-read, not the engine's `removed`). `?userId=` is `parseInt`-ed; non-finite -> ignored (purges all owners of that file); `String(userId)` is the engine owner id.

### resolveFile (shared by every route above)

38. `StreamingService.resolveFile(id, user?)`: 404 `MediaFile #<id> not found` when the row is missing **and** when the library ACL denies (same body, no existence leak: `getAccessibleLibraryIds(user)` is a concrete `number[]`; deny when `media.libraryId` is null or not in it); with `user` omitted (internal callers) ACL is skipped. 404 `Media "<title>" has no root folder assigned. Go to the media detail page and set a root folder.` when `media.path` is falsy (`<title>` falls back to `file.mediaId`). `absolutePath = path.resolve(media.path, file.relativePath)`; outside the root -> 404 `Invalid file path`; `fs.stat` failure -> 404 `File not found on disk: <absolutePath>`; `fs.realpath` outside the root (symlink escape) -> 404 `Invalid file path`. `ext = lower(extname(relativePath))`; `contentType` from `{.mp4,.m4v: video/mp4,.webm: video/webm,.mkv: video/x-matroska,.avi: video/x-msvideo,.mov: video/quicktime,.ts,.m2ts: video/mp2t}` else `application/octet-stream`. `size` = `stat.size`.
39. The root check is a string prefix test `startsWith(root + sep)` or equality.

### EDL

40. `parseEdl(text, fps?)` (Kodi/MPlayer EDL) -> `{ranges, rejected:[{line,reason}], sceneMarkers}`; exhaustive behaviour = vector set `edl` (155 cases). Summary: strip a leading BOM; split on `\r\n|\r|\n`; skip blank and `##` lines; tokens split on whitespace; action token = 3rd token (2nd when only two tokens) whose leading digits map `0 cut, 1 mute, 2 scene, 3 commercial` (leading zeros allowed, trailing junk ignored, anything else rejects `action`); 2-token lines are valid only for `scene`; times accept plain seconds (`12`, `12.`, `.5`), clock `[h:]m:s[.frac]` (fraction truncated to ms), or `#frame` (needs `fps > 0`, else reject `fps`), rounded to ms; reject reasons: `fields`, `action`, `time`, `fps`, `order` (`start >= end`), `limit` (more than `MAX_EDL_RANGES = 10000` ranges), `overlap` (against sorted neighbours; touching ranges are allowed); `scene` lines count in `sceneMarkers` and never produce a range; ranges are kept sorted by `start` (binary insertion).
41. `readEdlSidecar(absVideoPath, fps?)`: path = `<dir>/<name>.edl`, resolved case-insensitively by directory scan when the exact name is missing; `null` for missing/ENOENT/ENOTDIR/not a regular file/larger than 1 MiB (`MAX_EDL_BYTES`)/any other read error (warned once per key); parse cache keyed `path|fps` valid while `mtimeMs` and `size` match (cleared at 1000 entries); rejected lines are warned once (first 5 shown). Result = parsed `ranges` (may be `[]`). `shiftRanges(ranges, shift)`: `end = round((end+shift)*1000)/1000`, `start = round(max(0,start+shift)*1000)/1000`, drop ranges with `end <= start`.

### Burn-in

42. `SubtitleBurnInService.resolve(subtitleId, mediaFileId)` -> `BurnInInfo`: subtitle row missing or `sub.mediaFileId !== mediaFileId` -> 404 `Subtitle #<id> not found`; `resolveFile(mediaFileId)` **without user** (no ACL: the caller already passed it); `isImage = isImageBasedSubtitleCodec(sub.codec)` (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `xsub`); `cueOffsetSeconds = sourceTimeline(streamInfo).formatStart` (= `formatStartSeconds ?? video[0].startTimeSeconds ?? 0`). External file (`sub.relativePath`): `resolveSubtitleAbsolutePath(media.path, relativePath)` (null if outside root or blank -> 404 `Subtitle file not found on disk`), `realpath` (failure -> same 404), returns `{type: isImage?'image':'text', videoPath, subtitlePath: realPath, codec: sub.codec ?? 'unknown', cueOffsetSeconds}`. Embedded (`sub.streamIndex != null`): image -> `{type:'image', videoPath, streamIndex, codec}`; text -> `subtitleOrdinal = streamInfo.subtitles.findIndex(s => s.streamIndex === sub.streamIndex)`, `< 0`/unknown -> 404 `Embedded subtitle not found in the probed streams`, else `{type:'text', videoPath, streamIndex, subtitleOrdinal, codec}`. Neither -> 404 `Subtitle has no file path or stream index`. All of these are swallowed by step 4.
43. `buildFilter(info)` (pure; vector set `burn-in` fn `buildFilter`, 66 cases): `type:'text'` with `subtitlePath`: escape `\` -> `\\`, `:` -> `\:`, `'` -> `'\''`; extension (lower-case) `.ass`/`.ssa` -> `ass='<esc>'`, else `subtitles='<esc>'`; wrap with `atCueTime(filter, cueOffsetSeconds)`. Text without path but with `subtitleOrdinal != null` -> `subtitles='<esc(videoPath)>':si=<ordinal>` (no `atCueTime`). Everything else (image, or text with neither) -> `null` (image subs are overlaid by the engine from `streamIndex`).
44. `atCueTime(filter, offset = 0)` (vector fn `atCueTime`, 28 cases): `offset === 0` -> the filter unchanged; else `setpts=PTS<T1>,<filter>,setpts=PTS<T2>` with `T1 = ptsTerm(-1, offset)`, `T2 = ptsTerm(+1, offset)`; `ptsTerm(sign, s)`: `v = sign*s`; `(v < 0 ? '-': '+') + Number(abs(v).toFixed(6)) + '/TB'` (JS number printing, trailing zeros dropped; e.g. `setpts=PTS-2.778667/TB,subtitles='/s.srt',setpts=PTS+2.778667/TB`).
45. `listTextSubtitleRenditions(mediaFileId, user?)` (vector fn, 38 cases): `resolveFile(id, user)` (404 propagates); embedded: every `streamInfo.subtitles[]` entry with `isImageBased` falsy -> `{kind:'embedded', key: streamIndex, language: normalizeLanguageCode(language), languageTag, name: title || normalizeLanguageCode(language) || 'Subtitle', forced}`; then external `subtitle_files` of the file ordered by id ASC (query failure is caught and warned: embedded results are kept), keeping `isRenderableTextSidecar` (not image codec and extension in `.srt.ass.ssa.vtt`, case-insensitive): `{kind:'external', key: id, language: normalizeLanguageCode(language), name: language || 'Subtitle', forced}`. `normalizeLanguageCode`: trim, lower-case, split on `-`/`_`; empty -> `'und'`; folded two-part macro codes, ISO 639-2 -> 639-1 map, folded codes (tables in, owned by the languages data; the `burn-in` vectors embed expected outputs).

### Settings, hardware, config push

46. `StreamingSettingsCache.get()` loads the 12 `streaming_*` keys (see Settings keys), caches the result until any `streaming_*` setting changes (listener resets the cache, bumps an epoch so an in-flight load cannot commit stale values, and, when the engine is enabled, re-pushes `PUT /v1/config` streaming section; push failure only warned); concurrent callers share one in-flight load; a rejected load is not cached.
47. `HostHardwareService.apply(ss, redetect=false)`: pin `ss.gpuRenderNode` (`'auto'`/blank clears), remember the node; if `!engine.enabled` stop; `engine.pushStreaming(toEngineStreaming(ss))` (failure warned; the engine client serialises and dedupes pushes); when `redetect` or the node changed from the previous one, fire-and-forget refresh: `engine.capabilitiesFor(node)` polls `GET /v1/capabilities` once a second for up to 5 min until `caps.gpus` is empty or `caps.defaultGpu` equals the wanted node (`'auto'`/blank wants `/dev/dri/renderD128`), then stores the capabilities (failure warned, previous capabilities kept) and logs the `hwAccel`. Boot and each engine (re)connect run `apply(settings, true)`; playback-info runs `apply(settings)` (no redetect) every time.

### Source scans, backfill, stale probe

48. `SourceScanService.lookup(id, path, streamInfo?)`: `stat` failure -> warn, `{scan:null, version:null}`; else read `media_file_scans` row by `mediaFileId`; `current` = row `size` and `mtimeMs` equal the file's; `version = "<size>-<mtimeMs>"` (`mtimeMs` as JS number string, e.g. `99-1`); when current and `row.scan.breakSeconds != null` differs from `streamInfo.timestampBreakSeconds`, set it on the passed `streamInfo` (in place) and `UPDATE media_files SET "streamInfo" = jsonb_set("streamInfo",'{timestampBreakSeconds}', <json>::jsonb)` (failure warned); returns `{scan: current ? row.scan: null, version}`; a DB failure -> warn, `{scan:null, version}`. Never scans.
49. `scheduleIfNeeded(id, path, streamInfo, priority='low')`: no-op unless `streamInfo.video[0]` exists; deduped per file id by an in-flight promise map (callers share it); never rejects. Scan body: skip when `lookup(...).scan` exists; `stat` before; engine job `Scan` (`runJob({kind:{type:'Scan', info: streamInfo}, media:{mediaFileId, path}, priority})` -> `{scan}`); `stat` after: if size-mtime changed the scan is dropped with a warn; else `INSERT... ON CONFLICT ("mediaFileId") DO UPDATE` the row `{mediaFileId, size, mtimeMs, scan}`; then if `scan.breakSeconds ?? null` differs from `streamInfo.timestampBreakSeconds ?? null` store it via the `jsonb_set` update (warn log when non-null: `the timestamps break at <n>s; playback ends there`); any error -> warn only. Callers: the import (`ingest.md` rule 35) and a rescan that sees changed bytes (rule 43), both `normal` and detached; a manual rescan's `scanSources` and the backfill (rule 50), `low`; the hint of rule 17, `high`.
50. **Scan backfill** `tick()` every minute: return when a previous tick still runs, when the process is younger than 5 min (`BOOT_DELAY_MS`), or when `liveSessions.size() > 0`; else `nextPending()` (SQL below) past an in-memory `cursor` (highest id attempted this process; set before the attempt); no row -> done; `resolveFile(id)` without user (failure -> warn, skipped, cursor already advanced); `scheduleIfNeeded(id, absolutePath, streamInfo)` awaited (priority `low`). One file per tick.
51. **Stale-probe rescan** `schedule(id, path)`: no-op when the id is in the process-lifetime `rejected` set; deduped by an in-flight map; never blocks the caller. Re-probe: `stat` before, `FfprobeService.detectMediaFileInfo(path)`, `stat` after; changed (`version` differs) -> warn, drop; load the row, return when it has no `streamInfo`; **reject** (keep stored `streamInfo`, add id to `rejected`, still `scheduleIfNeeded(id, path, storedInfo)` fire-and-forget) when `fresh.error` or `!fresh.formatName` or (stored had `video[0]` and `fresh.video[0]` missing); else carry over `video[0].crop` and `timestampBreakSeconds` from the stored info, `UPDATE media_files SET "streamInfo" = <fresh>`, then fire-and-forget `scheduleIfNeeded(id, path, fresh)`. Any thrown error: warn, add to `rejected`, best-effort `scheduleIfNeeded` with the stored row's info.

### Sprite job

52. `ThumbnailService.generateForFile(file, media, subject, {force?, priority?='low'})`: `null` when `streamInfo.durationSeconds` is falsy or `media.path`/`file.relativePath` is missing; absolute path = `path.join(media.path, relativePath)`; activity key `GenerateSprite:<fileId>` (`upsertPending` before, `upsertRunning(pct rounded, 100)` on engine progress, `remove` in `finally`); `engine.runJob({kind:{type:'Sprite', info}, media:{mediaFileId, path}, priority, force})` -> `done.sprite` (`SpriteMeta`); failure -> warn, `null`. `deleteForFile(id)`: engine `POST /v1/invalidate {mediaFileId}` (best effort) and `rm -rf <cacheDir>/thumbnails/<id>` (failure warned). `onModuleInit`: when `cacheDir !== dataDir`, `rm -rf <dataDir>/thumbnails` and `thumbnails-tmp` (host-side thumbnail leftovers). `getSpritePath`/`getMetadataPath` return the host paths `<cacheDir>/thumbnails/<id>/sprite.{jpg,json}` only. `GenerateMissingSprites` passes every file with `force=false` and the engine cache answers (`scheduler.md` rule 28).

## SQL

All tables are in the schema (`server/migrations`).

1. **resolveFile** (with relations):
   `SELECT mf.*, m.*, l.* FROM media_files mf LEFT JOIN media m ON m.id = mf."mediaId" LEFT JOIN libraries l ON l.id = m."libraryId" WHERE mf.id = $1 LIMIT 1`
2. **Library ACL ids** `getAccessibleLibraryIds(user)`: owned by the libraries spec (admin or `manage:all` -> every `libraries.id`; else `library_user_access` rows of the user).
3. **Saved position** `getState(userId, mediaId, episodeId)`:
   `SELECT ps.* FROM playback_states ps WHERE ps."userId" = $1 AND ps."mediaId" = $2 AND (ps."episodeId" = $3 | ps."episodeId" IS NULL when $3 is absent/0) LIMIT 1`
4. **markSessionStarted**: `findState` as in 3; if found `UPDATE playback_states SET "mediaFileId" = $mf, "lastPlayedAt" = now, "updatedAt" = now WHERE id = $id`; else `INSERT INTO playback_states ("userId","mediaId","mediaFileId","episodeId","positionSeconds","durationSeconds",completed,"lastPlayedAt") VALUES ($u,$m,$mf|NULL,$ep|NULL,0,0,false,now)` (`playedAt` left NULL; `hiddenFromContinueWatching` default false).
5. **Markers read** `findOne` x2:
   `SELECT * FROM episode_markers WHERE "episodeId" = $1 AND type = 'intro' LIMIT 1` and the same with `type = 'outro'`. Used fields: `startSeconds`, `endSeconds` (float8). Unique `(episodeId, type)`; read-only here.
6. **External subtitle renditions**:
   `SELECT * FROM subtitle_files WHERE "mediaFileId" = $1 ORDER BY id ASC`
7. **Burn-in subtitle row**: `SELECT * FROM subtitle_files WHERE id = $1 LIMIT 1` (compared with `mediaFileId` in code).
8. **Scan row read / write**: `SELECT * FROM media_file_scans WHERE "mediaFileId" = $1 LIMIT 1`; upsert on unique `UQ_media_file_scans_media_file ("mediaFileId")`: `INSERT INTO media_file_scans ("mediaFileId", size, "mtimeMs", scan) VALUES (...) ON CONFLICT ("mediaFileId") DO UPDATE SET size = EXCLUDED.size, "mtimeMs" = EXCLUDED."mtimeMs", scan = EXCLUDED.scan, "updatedAt" = now()` (`size` bigint, `mtimeMs` double precision, `scan` jsonb; rows cascade-delete with the file).
9. **Clock break in place**:
   `UPDATE media_files SET "streamInfo" = jsonb_set("streamInfo", '{timestampBreakSeconds}', '<json number|null>'::jsonb) WHERE id = $1`
10. **Backfill candidate** (verbatim):
    ```sql
    SELECT mf.id FROM media_files mf
    LEFT JOIN media_file_scans mfs ON mfs."mediaFileId" = mf.id
    WHERE mfs.id IS NULL
      AND mf.id > $1
      AND mf."streamInfo" -> 'video' -> 0 IS NOT NULL
    ORDER BY mf.id ASC
    LIMIT 1
    ```
11. **Re-probe write**: `SELECT * FROM media_files WHERE id = $1 LIMIT 1`; `UPDATE media_files SET "streamInfo" = $json WHERE id = $1`.
12. **Admin streams batch reads**: `SELECT * FROM media_files WHERE id IN (...distinct session file ids)`; `SELECT e.*, s.* FROM episodes e LEFT JOIN seasons s ON s.id = e."seasonId" WHERE e.id IN (...)`.

## Events

| Event | Audience | Payload | Emitter / consumer |
|---|---|---|---|
| `remote.stopped` | the presence owner's connections (+ household fan-out) | `{type:'remote.stopped', targetId}` | emitted by `DELETE sessions/:sid` only when `targetIdFor(live.sseConnectionId)` resolves; consumed by remote controllers |
| `remote.targets_changed` | same | `{type:'remote.targets_changed'}` | emitted by `DELETE sessions/:sid` whenever presence had a `userId` |
| `player.command` | the presence's SSE connection if still connected, else every connection of the owner | `{type:'player.command', sessionId, mediaFileId, userId, action, message?}` | `POST /system/streams/:sid/command`; consumed by the player (filters on `sessionId`) |
| attribution claim | in-process (`EventsService`) | `{targetId -> {userId, mediaFileId, at}}` | taken at step 9, given back on a failed open |

Engine `SessionOpened/SessionEnded/PipelineChanged/SegmentServed/BgJobDone` consumption is the engine-glue spec's.

## Settings keys

Read through `SettingsService.get(key)` (string or null) by `StreamingSettingsCache.load()`:

| key | default / parsing |
|---|---|
| `streaming_segment_duration` | `parseFloat(v ?? '3') \|\| 3` |
| `streaming_qsv_preset` | `v ?? 'faster'`, not validated |
| `streaming_tonemap_algo` | one of `auto,opencl,vaapi,qsv`, else `'auto'` |
| `streaming_tonemap_curve` | one of `hable,mobius,reinhard`, else `'mobius'` |
| `streaming_cache_max_gb` | positive finite number -> `round(gb * 1024^3)` bytes, else 20 GiB |
| `streaming_cache_ttl_hours` | positive finite -> `round(h * 3 600 000)` ms, else 4 h |
| `streaming_ffmpeg_slots` | positive finite number, else `null` (engine derives) |
| `streaming_auto_quality_mode` | `directplay` \| `abr`, else `'directplay'` |
| `streaming_auto_crop_enabled` | `false` only for the exact string `'false'` |
| `streaming_gpu_render_node` | trimmed, blank -> `'auto'` |
| `streaming_throttle_enabled` | `false` only for the exact string `'false'` |
| `streaming_throttle_threshold_seconds` | `max(60, positive(v) ?? 90)` |

"positive" = `Number(v)` finite and `> 0`. Env defaults: `STREAM_LIVE_SESSION_TTL_MS` 30 000, `STREAM_LIVE_SESSION_GC_INTERVAL_MS` 5 000, `STREAM_SESSION_REVIVE_TTL_MS` 900 000, `STREAM_MAX_SESSIONS_PER_USER` 10, `STREAM_JOB_GRACE_MS` 60 000, `STREAM_JOB_FALLBACK_TIMEOUT_MS` 1 800 000, `TRANSCODE_CACHE_GC_INTERVAL_MS` 300 000 (positive integers only, else default): pushed to the engine as `lifetime` by the config owner (engine glue spec).

## Jobs/timers

| Job | Schedule | Behaviour |
|---|---|---|
| Scan backfill | every minute | rule 50 |
| Source scan | on demand (playback-info hint, post-import, backfill) | rule 49 |
| Stale re-probe | on demand (playback-info hint) | rule 51 |
| Sprite generation | on demand (rescan, post-import; `GenerateSprites` / `GenerateMissingSprites` triggers, `scheduler.md` rule 28) | rule 52 |
| Hardware re-detect | boot, engine (re)connect, GPU re-pin | rule 47 |
| Engine open retry | inside `openSession`, 503 + `Retry-After` up to 15 s | rule 13 |

## Vectors/parity

- Vector sets: `burn-in` = `server/fixtures/burn-in/cases.json` (133 cases, `atCueTime` and `buildFilter` replayed in fliks-server against `fliks-engine-core`, the rest in `fliks_domain`: `atCueTime` 28, `buildFilter` 66, `listTextSubtitleRenditions` 39; `resolve` is not covered: DB + fs); `edl` = `server/fixtures/edl/cases.json` (158 cases: `parseEdl` 120, `shiftRanges` 18, `edlPathFor` 8, `readEdlSidecar` 9, `readEdlSidecarSteps` 3, the last two with a virtual `files` map).
- Golden: `server/fixtures/playback-info/engine-playback.recorded.json` (header of this file). Rust unit cases cover: open request body, presence fields, attribution take/give-back, resume from saved position, download pins and skips history, markers/pre-roll/chapters, EDL shift by `playbackClockOffsetS`, 503/400 mapping.
- Parity scenarios (`server/parity/scenarios/stream/`): `playback-info-*` (`transcode`, `direct-play`, `remux`, `episode`, `download`, `unauthenticated`, `bearer-and-query-auth`, `unknown-file`, `unknown-file-engine-down`, `readonly-library-denied`, `validation`, `validation-bad-device-type`, `extra-properties-stripped`, `non-integer-id`, `engine-down`, `start-at-audio-quality`, `start-at-non-numeric`, `then-qualities-and-edl`), `qualities-*`, `edl-*`, `hw-accel-*`, `tonemap-algos-*`, `effective-settings-*`, `gpus-*` (each `ok` and `unauthenticated`), `session-delete-*` (`own`, `other-user-forbidden`, `unknown`, `unauthenticated`), `streams-list-*`, `streams-command-*` (`pause`, `stop`, `message`, `unknown-session`, `forbidden`, `unauthenticated`), `transcode-cache-*` (`get`, `delete`, `delete-media`, each with its `forbidden`, `unauthenticated`, `ok`, and `unknown` / `non-integer` cases). Scenarios needing a running engine use the engine of `parity/run-all.sh` (up and down modes).
- Ignore paths: `$..sessionId`, `$..profileHash`, `$..playUrl` (sid), `$..startedAt`, `$..lastActivity`.

## Open questions

1. A markers-query failure leaves an opened engine session and presence behind (rule 18): keep, or close the session on that path.
2. `startAt=abc` passes `NaN` through (rule 1): keep (JSON `null`) or reject.
