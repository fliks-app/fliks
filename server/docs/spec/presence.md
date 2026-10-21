# Spec: presence (LiveSessionRegistry + engine-presence)

Scope: the engine protocol it mirrors is `fliks-engine/PROTOCOL.md` (`GET /v1/sessions`, `GET /v1/events`, heartbeat) and `fliks-engine/docs/spec/runtime.md` (GC, tombstones).

Presence = the host's in-memory view of the engine's on-demand playback sessions (who watches what, on which SSE connection), feeding remote control, the admin streams page, QoE and the scan-backfill gate. The engine owns session lifetime; presence is a rebuildable mirror. Live TV viewers are NOT here: they live in the live TV session registry.

No HTTP routes belong to this domain; routes that read or write it are listed in Rules.

## Routes

none of its own. Routes that touch presence (specified in their own domain specs, referenced here by what they do to the registry):

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `POST /api/stream/:mediaFileId/playback-info` | authenticated user | see `playback-info.md` | see `playback-info.md` | see `playback-info.md` | `create` (rule 4) |
| `PUT /api/playback/media/:mediaId/state` | authenticated user, session-token guard | see `heartbeat.md` | see `heartbeat.md` | see `heartbeat.md` | `peek`, lazy restore, `heartbeat`, emits `remote.state` |
| `POST /api/playback/sessions/:sessionId/events` | authenticated user | see `qoe.md` | see `qoe.md` | see `qoe.md` | `peek` (ownership check for QoE events) |
| `DELETE /api/stream/sessions/:sessionId` | authenticated user | see `playback-info.md` | see `playback-info.md` | see `playback-info.md` | `peek`, ownership check, `stop` |
| `GET /api/system/streams` | `Read Settings` | see `playback-info.md` | see `playback-info.md` | see `playback-info.md` | `list` filtered (rule 12) |
| `POST /api/system/streams/:sessionId/command` | `Manage Settings` | see `playback-info.md` | see `playback-info.md` | see `playback-info.md` | `peek`, `stop` on `stop` action |
| `GET /api/remote/targets` | authenticated user | see `remote.md` | see `remote.md` | see `remote.md` | `list` for `nowPlaying` (see `remote.md`) |

## Rules

State
1. State: a map `sessionId -> LiveSession` (key = the engine's sid, embedded in every heartbeat and HLS URL), created empty at boot, cleared on shutdown. No secondary index: lookup by SSE connection id is a linear scan of `list()`.
2. `LiveSession` fields (all always present, `null` not absent): `sessionId`, `userId: number|null`, `username`, `mediaFileId`, `mediaTitle`, `mediaType`, `posterUrl`, `fanartUrl`, `profileHash`, `quality`, `qualities: RemoteQualityRung[]|null`, `attributedUserId: number|null`, `autoplayBlocked: boolean`, `hasNext: boolean`, `kind: 'transcode'|'remux'|'directplay'`, `deviceLabel`, `systemName`, `appVersion`, `sseConnectionId`, `startedAt: epoch ms`, `lastBeat: epoch ms`, `position: seconds`, `state: 'playing'|'paused'|'buffering'`, `episodeLabel`, `supportsVolume: boolean`, `subtitleId`, `audioTrackIndex`, `subtitleTrackIndex`, `volume`, `muted`, `audioPlan: AudioPlan|null`, `sourceFps: number|null`, `bitrateByQuality: Record<string, BitrateHint>|null`, `hdrLadder: boolean`, `transcodeReasons: TranscodeReason[]`, `clientTonemap: boolean`. `list()` returns snapshots with `startedAt`/`lastBeat` as `Date`.
3. Defaults at creation: `qualities null`, `autoplayBlocked false`, `hasNext false`, `state 'playing'`, `episodeLabel null`, `supportsVolume true`, `subtitleId null`, track indexes `null`, `volume null`, `muted null`, `position input ?? 0`, `startedAt = lastBeat = now`, `hdrLadder false`, `transcodeReasons []`, `clientTonemap false`, every other optional input `?? null`.

Writers
4. `create(input)` (playback-info): always overwrites an entry with the same sid; built by `presenceInput(facts)` from the engine's open response `{ sessionId, profileHash?, decision }`, `kind` from `decision.response.playMethod` (`DirectPlay`->`directplay`, `DirectStream`->`remux`, else `transcode`), the host's `client` info and the `tags` it sent to the engine; right after, `qoe.register(live)` and `qoe.setPipeline(...)` (QoE spec).
5. `presenceInput` mapping (`PresenceFacts` -> input): `username/mediaTitle/mediaType/posterUrl/fanartUrl/sseConnectionId = tags.<key> ?? null`; `attributedUserId = Number(tags.attributedUserId)` kept only when `Number.isInteger`, else null; `deviceLabel = client.userAgent ?? null`; `systemName = client.systemName ?? null`; `appVersion = client.appVersion ?? null`; `position = positionS`; `audioPlan = decision.response.audioPlan`; `bitrateByQuality = decision.response.transcodeBitrateByQuality ?? null`; `hdrLadder = decision.useHdrLadder`; `clientTonemap = decision.response.clientTonemap`; `transcodeReasons = decision.response.transcodeReasons`; `sourceFps = parseSourceFps(decision.response.source.frameRate ?? undefined)`.
6. Tags (engine-opaque `Record<string,string>` written at open, the only data that survives a host restart): `toTags` keeps keys `username, mediaTitle, mediaType, posterUrl, fanartUrl, sseConnectionId, attributedUserId`, dropping `null`/`undefined`/`''`, stringifying values. Every other `LiveSession` field is recomputed from the engine snapshot or defaulted after a restore (rule 9).
7. `heartbeat(sid, payload)`: unknown sid -> `null`. Else `lastBeat = now` and each payload field overwrites only when `!== undefined` (so `null` clears; `position, state, quality, qualities, autoplayBlocked, hasNext, episodeLabel, supportsVolume, subtitleId, audioTrackIndex, subtitleTrackIndex, volume, muted`); `state` only when truthy; `sseConnectionId` only when truthy (a present value rebinds the session to the new SSE connection, which is how a reconnect re-attaches presence to its target). Returns the live entry.
8. `stop(sid)`: if present, notifies QoE (`qoe.sessionEnded(session)`) then deletes; returns whether the sid was known. Idempotent. Presence never calls the engine on stop: callers (`DELETE /stream/sessions/:sid`, admin `stop`) call `engine.deleteSession(sid)` themselves.
9. `restorePresence(registry, snapshot)` = `create(presenceFromSnapshot(s))` then `syncFromSnapshot`: `userId = Number(s.ownerId)` if integer else null; `startedAt = s.openedAtMs`, `lastBeat = s.lastBeatMs` (the engine's clocks), `state = s.state` when `paused|buffering` else `playing`; `position = s.positionS`; `quality = s.quality ?? null`; `kind = s.kind`. NOT restored (defaults, refilled by the next client heartbeat within about 10 s): `qualities, autoplayBlocked, hasNext, episodeLabel, supportsVolume, subtitleId, audioTrackIndex, subtitleTrackIndex, volume, muted`. A restore does not call `qoe.register` (QoE trackers are separate, in-memory, lost on restart).

Lifetime
10. The registry has no TTL, no timer, no GC: its doc says "the engine owns expiry, the per-owner cap and the revive window". The only removals are `stop(sid)` from: `DELETE /api/stream/sessions/:sid`, admin `POST /api/system/streams/:sid/command` with `action: 'stop'`, engine event `SessionEnded` (any reason: `stopped`, `expired`, `evicted`, `revoked`), the resync diff (rule 14), and shutdown.
11. Engine side (reference, `runtime.md`): a session whose last heartbeat is older than `liveSessionTtlMs` (30 000 default, env `STREAM_LIVE_SESSION_TTL_MS`; pinned sessions use `pinnedSessionTtlMs`) becomes a tombstone and emits `SessionEnded{reason:'expired'}`; a heartbeat within `sessionReviveTtlMs` (15 min, env `STREAM_SESSION_REVIVE_TTL_MS`) revives it (`sessionLost: false`), later heartbeats get `sessionLost: true`. `maxSessionsPerOwner` (10, `STREAM_MAX_SESSIONS_PER_USER`) evicts the oldest (`evicted`). The host pushes these in `PUT /v1/config` `lifetime`; env reads are lazy: positive integer else default.
12. Staleness filters in readers (the registry itself never hides stale entries): (a) admin `GET /api/system/streams`: when the engine runs playback and `GET /v1/sessions` answers, a registry entry is shown only if its sid is in the engine list; if the engine listing fails or the engine has no runtime, fall back to `lastBeat > now - liveSessionTtlMs`; (b) remote `nowPlaying` omitted when `now - lastBeat > liveSessionTtlMs`.

Resync (engine events consumer)
13. Consumer lifecycle: started when the engine becomes ready (`whenReady().then(restart)`) and on every engine (re)connect (`engine.onConnect(restart)`, i.e. engine instance change); no-op when `!engine.runtime`; each restart aborts the previous loop.
14. Loop: open `GET /v1/events` (SSE); non-2xx or no body = error; arm a 45 s idle watchdog (reset on every received chunk, keep-alives included; the engine pings every 15 s); only then, with the stream subscribed (an event between subscribe and list is replayed, never lost), call `resync()`; reset backoff to 500 ms; then handle each `data:` JSON as an `EngineEvent`. On any error or idle abort: log warn, sleep `backoff`, double it (500 ms -> 15 s cap), reconnect and resync again. If `resync()` throws (engine list failed), the connection is dropped and retried with backoff; presence is left as it was.
15. `resync()`: `listedAt = now`; `snaps = GET /v1/sessions` (no filter); for each snapshot unknown to the registry -> `restorePresence`; for each registry entry NOT in the snapshot list AND `startedAt < listedAt` -> `stop(sid)` (a session opened after the list was taken is kept); then the job set is rebuilt (`jobs.clear()`, add `jobKeyOf(s)` = `<mediaFileId>-<u<ownerId>|anon>-<profileHash>` for each snapshot with `job.state === 'running'`), `engine.resyncJobs()` (background-job waiters, engine spec), then every `onResync` listener (live TV) in parallel. Existing entries are NOT updated from the snapshot (only missing ones are created and orphans dropped).
16. `stop` during resync calls `qoe.sessionEnded` for each dropped orphan (rule 8), so a host restart followed by a resync closes QoE for sessions the engine lost meanwhile.
17. Event handling affecting presence: `SessionOpened` -> `restorePresence` if the sid is unknown (a playback-info on another instance, or a race with `create`); `SessionEnded{sessionId}` -> `stop`; `PipelineChanged{sessionId, quality, hwAccel}` -> if present: for `kind === 'transcode'` `qoe.noteServedRung(live, quality, servedRungBitrate({...live, quality}))`, then `qoe.noteHwAccel(live, hwAccel)`; `SegmentServed` -> `qoe.observeServed(...)` (`segmentDuration` setting, `sourceFps`, `waitedMs`, `cmcdRaw`); the presence entry is read-only in these (it is not mutated by `PipelineChanged`: the admin page reads the engine's `quality`/`actualHw` live, rule 19). `JobStarted/JobEnded` maintain only the job-key set (`activeJobs`, QoE load probe).
18. Lazy restore on heartbeat: with the engine running playback, `PUT /playback/media/:id/state` first asks the engine to heartbeat (`ownerId = String(known?.userId ?? user.id)`, `positionS`, `state`, `quality`); if the engine did not lose the session and the registry does not know the sid, `GET /v1/sessions/{sid}` -> `restorePresence`. This repairs a host restarted between resyncs (the heartbeat can arrive before the first resync completes). Ownership check before: `known.userId != null && known.userId !== user.id && known.attributedUserId !== user.id` -> 403 `Not your session`; an engine 403 -> the same. Engine failure -> warn, `undefined` (the registry answers on its own).
19. Heartbeat result (contract detail owned by `playback` spec): `engineLost` true -> `updated = null` -> `sessionLost: true` to the client (client re-issues playback-info); the stale registry entry is not removed here, the engine's `SessionEnded` does it; when the engine could not be asked (`undefined`) -> `sessionLost = !updated` from the registry.

Readers
20. Admin streams page `GET /api/system/streams` (policy `Read Settings`): one row per live entry (after rule 12) joined with the engine snapshot `eng = engineSessions.get(sid)`: `mode = session.kind`; `quality = kind==='directplay' ? 'original' : (eng?.quality ?? session.quality ?? 'original')`; `hwAccel`/`actualHw`: `'none'` for `directplay` and `remux`, else `eng?.job?.actualHw ?? hostHwAccel` (host's detected `HostHardwareService.hwAccel`, `'none'` default); `lastActivity = eng ? eng.lastBeatMs : session.lastBeat` (ISO); `startedAt = session.startedAt` ISO; `positionSeconds = session.position` (fresher than the debounced `playback_states` row); `job = eng.job ?? null`; `transcodePercent`, reason lists from `eng.job.transcodePercent` and `eng.decision.response.transcodeReasons` (prefix `Video`/`Audio`/`Container`, message text); live TV rows are appended after the on-demand rows. The full DTO is specified with the system controller; presence supplies `sessionId, userId, username, mediaFileId, mediaTitle, mediaType, posterUrl, kind, quality, deviceLabel, systemName, appVersion, clientTonemap, audioPlan, hdrLadder, bitrateByQuality, position`.
21. `engineSessions()`: `null` when `!engine.runtime`; otherwise `GET /v1/sessions` into a `Map<sid, SessionSnapshot>`; any error is swallowed with a warn and treated as `null`.
22. Admin remote player command `POST /system/streams/:sid/command` (`pause|play|stop|message`): `peek(sid)`; unknown sid or `userId == null` -> 400 `Session not found`; emits SSE `player.command { sessionId, mediaFileId, userId, action, message? }` to the session's `sseConnectionId` when the hub still has that connection, else to every connection of `live.userId` (clients filter on `sessionId`); on `stop` also `stop(sid)` and a best-effort engine `DELETE /v1/sessions/{sid}` (warn on failure); response `{ ok: true }`.
23. `DELETE /api/stream/sessions/:sid`: owner = registry `userId` if present else the engine's `ownerId` (`GET /v1/sessions/{sid}`, only when `engine.runtime`, errors -> null); a known owner different from the caller needs `Manage Settings`, else 403 `Not your session`; then (if the entry has a `userId`) emits `remote.stopped { targetId }` when `targetIdFor(sseConnectionId)` resolves, plus `remote.targets_changed`, to that user; `stop(sid)`; engine `deleteSession` (idempotent) when `engine.runtime`; status 204 even for an unknown sid.
24. Other readers: QoE load probe `activeSessions = list().length` with `activeTranscodes = EngineEventsService.activeJobs`; scan-backfill cron skips its tick while `size() > 0`; QoE events route uses `peek(sid) ?? qoe.trackedSession(sid)` and requires `live.userId === user.id || live.attributedUserId === user.id` else 403 `Not your session`, silent 204 for an unknown session.
25. Presence is per-process memory: a second host instance would not share it; the engine list is the source of truth after any restart (rule 15). Persistence is not required: no consumer reads presence from the database, and the resync + lazy restore rebuild it.

## SQL

none (presence is in memory). Readers that join presence with the database (admin streams: `media_files` by id, `episodes` + `seasons`) are specified with the system controller.

## Events

| Event | Direction | Audience | Payload | Notes |
|---|---|---|---|---|
| `SessionOpened{session: SessionSnapshot}` | engine -> host (`GET /v1/events`) | presence | snapshot | `restorePresence` if unknown |
| `SessionEnded{sessionId, reason}` | engine -> host | presence + QoE | sid, reason | `stop(sid)` |
| `PipelineChanged{sessionId, quality, hwAccel}` | engine -> host | QoE | | not applied to presence |
| `SegmentServed{sessionId, ..., cmcdRaw, waitedMs}` | engine -> host | QoE | | not applied to presence |
| `JobStarted{jobKey}` / `JobEnded{jobKey}` / `BgJob*` | engine -> host | job set / `runJob` waiters | | engine spec |
| `remote.state`, `remote.stopped`, `remote.targets_changed` | host -> SSE | see `remote.md` | | emitters read presence (rules 19, 23) |
| `player.command { type, sessionId, mediaFileId, userId, action: 'pause'\|'play'\|'stop'\|'message', message? }` | host -> SSE | one connection or one user | | rule 22; hub name by `events-hub.md` |

`SessionEnded.reason` values in the engine spec: `stopped`, `expired`, `evicted`, `revoked`.

## Settings keys

none. Env (lazy, positive int else default): `STREAM_LIVE_SESSION_TTL_MS` 30 000, `STREAM_LIVE_SESSION_GC_INTERVAL_MS` 5 000, `STREAM_SESSION_REVIVE_TTL_MS` 900 000, `STREAM_MAX_SESSIONS_PER_USER` 10, `STREAM_JOB_GRACE_MS` 60 000, `STREAM_JOB_FALLBACK_TIMEOUT_MS` 1 800 000: pushed to the engine as `lifetime`; the host itself only reads `liveSessionTtlMs` (remote staleness, admin fallback). `liveSessionGcIntervalMs` has no host-side consumer: the registry has no GC.

## Jobs/timers

- No host timer for presence. Engine events consumer: reconnect backoff 500 ms doubling to 15 s, idle watchdog 45 s (engine ping 15 s), resync on every (re)connect.
- Heartbeat cadence (client): about 10 s per playing session (fan-out comment in the remote service); presence staleness thresholds 30 s (rule 12).

## Vectors/parity

No `server/fixtures` set: the Rust tests in `crates/server/src/presence/tests.rs` cover the rules (snapshot to `LiveSession` mapping, `toTags`, `jobKeyOf`).

Parity: presence has no scenario directory of its own; it is exercised through `server/parity/scenarios/playback/` (`heartbeat-live-session`, `heartbeat-other-user-session`, `heartbeat-session-lost`), `qoe/` (`events-own-session`, `events-not-your-session`, `events-unknown-session`) and `stream/`. The cross-process behaviours (resync after a server restart restores the session with the engine's `startedAt`/`lastActivity`, and a heartbeat then refills `volume`/`subtitleId`; a session ended while the server is down is absent after restart) are manual runner steps.
