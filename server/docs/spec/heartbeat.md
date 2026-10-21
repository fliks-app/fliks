# Spec: playback heartbeat (`PUT /api/playback/media/:mediaId/state`)

The rest of `/api/playback/*` is `playback-state.md`; the QoE parsers and trackers are `qoe.md`; the SSE hub and remote targets belong to the realtime spec.

This route does five things in a fixed order on every beat, with only partial failure isolation. The order and what happens when each step throws are in Rules 5-17 and the matrix in Rule 18.

## Routes

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `PUT /api/playback/media/:mediaId/state` | `JwtOrApiKeyGuard` (class), then `SessionTokenGuard` (method); policies none; status **200** | path `mediaId` numeric. Body (**no validation, no whitelist, no transform**; fields are used as received): `positionSeconds:number`, `durationSeconds:number`, `mediaFileId:number`, `episodeId?:number`, and the optional heartbeat fields `sessionId?:string`, `state?:'playing'\|'paused'\|'buffering'`, `quality?:string\|null`, `qualities?:RemoteQualityRung[]\|null`, `autoplayBlocked?:boolean`, `hasNext?:boolean`, `episodeLabel?:string\|null`, `supportsVolume?:boolean`, `subtitleId?:string\|null`, `audioTrackIndex?:number\|null`, `subtitleTrackIndex?:number\|null`, `sseConnectionId?:string`, `targetId?:string`, `volume?:number`, `muted?:boolean`, `lastCmdId?:string`, `qoe?:unknown`. Header `x-fliks-sse-connection` | one of four bodies (Rule 17): empty body, `{"sessionLost":true}`, `{"state":<PlaybackState\|null>}`, `{"sessionLost":true,"state":<PlaybackState\|null>}` | 400 `Validation failed (numeric string is expected)` (bad `:mediaId`); 400 `mediaId and mediaFileId are required` (rule 15); 401; 403 `session_token_required` (stream/cast scoped token); 403 `Not your session` (rule 6); 500 (any uncaught throw, rule 18) | engine heartbeat, presence update, QoE sample, `remote.state` SSE emit, debounced `playback_states` upsert, playlist auto-remove |

`state` is the playback-state row serialised with every column (dates as ISO strings). Its JSON shape depends on the path taken (Rule 16).

## Rules

### Inputs

1. The handler holds one in-memory map of `{at:number, pos:number}` (`lastDbWriteAt`), per process, never persisted; a restart forgets it.
2. `sseConnectionId` = `body.sseConnectionId ?? header x-fliks-sse-connection ?? (body.targetId ? "polled:" + body.targetId: undefined)`. `??` keeps `''` from the body (then the registry ignores it, rule 8).
3. Without `body.sessionId` the whole presence block (rules 5-11) is skipped: no engine call, no QoE, no `remote.state`; only the history write (rules 12-16) runs, and the response never has `sessionLost`.

### Order of side effects (with `body.sessionId`)

4. Order, each `await`ed in sequence: (a) engine beat (rule 5, only when `engine.runtime`), (b) registry `peek` then `heartbeat` (rules 7-8), (c) derive `attributedUserId`, `stateChanged`, `sessionLost` (rule 9), (d) QoE sample (rule 10), (e) `remote.state` emit (rule 11), (f) debounce decision (rules 12-13), (g) `lastDbWriteAt.set` + stale prune (rule 14), (h) `playbackService.updateState` (rule 15, includes the playlist cleanup), (i) response (rule 17). Steps (a) and (h) are the only ones that await I/O; (b)-(g) are synchronous, so the debounce check-and-set cannot interleave between two concurrent beats of the same process.
5. **Engine beat** (`engineBeat`), only when `this.engine?.runtime`: (i) `known = registry.peek(sid)`; (ii) ownership: if `known.userId != null` and `known.userId !== user.id` and `known.attributedUserId !== user.id` -> **throw** 403 `Not your session` before any engine call and before any registry change; (iii) `engine.heartbeat(sid, {ownerId: String(known?.userId ?? user.id), positionS: body.positionSeconds, state: body.state, quality: body.quality ?? undefined})` = `POST /v1/sessions/{sid}/heartbeat`, answer `{sessionLost:boolean}`; (iv) when `!sessionLost && !known`: `engine.getSession(sid)` (`GET /v1/sessions/{sid}`, `null` on 404) and if a snapshot comes back `restorePresence(registry, snap)` (creates presence with `presenceFromSnapshot`, then `startedAt = openedAtMs`, `lastBeat = lastBeatMs`, `state = snapshot.state` if `paused`/`buffering` else `'playing'`); (v) return `sessionLost`. The whole of (iii)-(v) is in one `try`: an `EngineError` with status 403 (from either call) -> 403 `Not your session`; **any other** error (engine down, non-2xx, `getSession` or `restorePresence` throwing, network) -> warn `engine heartbeat failed: <msg>` and return `undefined` ("could not be asked"), even when the heartbeat itself had succeeded. Without `engine.runtime` the step is skipped (`engineLost` stays `undefined`) and no ownership check is made at all.
6. The 403 of rule 5 propagates out of the handler unwrapped, so nothing after it runs: no registry update, no QoE, no emit, no history write for that beat.
7. **Presence read**: `before = registry.peek(sid)` is taken **after** the engine beat, so a presence just rebuilt by rule 5(iv) counts as existing, and `previousState = before?.state` is the snapshot-derived state.
8. **Presence update**: `updated = engineLost ? null: registry.heartbeat(sid, {...})`. When `engineLost === true` the registry is **not touched** (entry kept with its previous `lastBeat`; it only ends via the engine's `SessionEnded`, the events-consumer resync, `DELETE /api/stream/sessions/:sid` or the admin stop). `registry.heartbeat` returns `null` for an unknown sid; otherwise it sets `lastBeat = Date.now` and applies each provided field: `position = body.positionSeconds` when `!== undefined`; `state` only when truthy (**any string is stored, no enum check**); `quality`, `qualities`, `autoplayBlocked`, `hasNext`, `subtitleId`, `supportsVolume`, `episodeLabel`, `audioTrackIndex`, `subtitleTrackIndex`, `volume`, `muted` when `!== undefined` (so `null` is stored); `sseConnectionId` only when truthy.
9. Derived values: `attributedUserId = updated?.attributedUserId ?? null`; `stateChanged = !!updated && !!body.state && previousState !== body.state`; `sessionLost = engineLost ?? !updated`. Because of `??`, `engineLost === false` wins even when `updated` is `null` (presence unknown and not restorable): `sessionLost` is then **false**. `engineLost === undefined` (no engine runtime, or engine could not be asked) falls back to `!updated`.
10. **QoE sample**: only when `updated` and `body.qoe != null` and (`updated.userId === user.id` or `updated.attributedUserId === user.id`). `parseSample(body.qoe)` (pure, `qoe.md`); `null` -> skipped. Else `sample.variantBitrate ??= servedRungBitrate(updated)`; `qoe.recordSample(updated, sample)`; then `rung = servedRungBitrate(updated)` and, only when `rung != null` and `typeof updated.quality === 'string'` and `updated.quality !== 'auto'` and `updated.quality.length <= 32`, `qoe.updatePipelineOutput(updated, updated.quality, rung)`. `servedRungBitrate` is `servedRung(s)?.videoBitrateBps || null`; `servedRung` is `null` unless `kind === 'transcode'`, `quality` is a string and `bitrateByQuality` exists; key = `quality + '-hdr'` when `hdrLadder` and the quality does not already end in `-hdr`, looked up first, then the plain `quality`. QoE disabled (`qoe_enabled = 'false'`) makes both QoE calls no-ops.
11. **`remote.state` emit**: when `updated` is truthy (so never when `engineLost`, never for an unknown sid, **every beat**, not only on a DB flush): `targetId = events.targetIdFor(updated.sseConnectionId)` (the id **stored on the presence**, not the request's; resolves through live SSE connections and polled targets); with a target, `events.emitToUser(user.id, {type:'remote.state',...})` (audience = the **request user**, widened by the household fan-out the remote service registered for `remote.state`); without a target, only a `debug` log. Payload (keys exactly): `targetId, sessionId: body.sessionId, mediaId: <path>, mediaFileId: body.mediaFileId, episodeId: body.episodeId ?? null, mediaTitle: updated.mediaTitle, episodeLabel: updated.episodeLabel, posterUrl: updated.posterUrl, fanartUrl: updated.fanartUrl, positionSeconds: updated.position, durationSeconds: body.durationSeconds, state: updated.state, volume: updated.volume, muted: updated.muted, supportsVolume: updated.supportsVolume, subtitleId: updated.subtitleId, quality: updated.quality, qualities: updated.qualities, autoplayBlocked: updated.autoplayBlocked, hasNext: updated.hasNext, audioTrackIndex: updated.audioTrackIndex, subtitleTrackIndex: updated.subtitleTrackIndex, lastCmdId: body.lastCmdId ?? null`.

### Debounced history write

12. `historyUserId = attributedUserId ?? user.id` (a playback launched by remote control counts for the launcher; the device keeps its own login). When the engine said `sessionLost`, `attributedUserId` is `null` (rule 8), so the write goes to `user.id`. `dbKey = historyUserId + ":" + mediaId + ":" + (body.episodeId ?? 0)` (`mediaId` from the path).
13. Decision: `now = Date.now`, `last = map.get(dbKey)`, `dur = body.durationSeconds ?? 0`, `pos = body.positionSeconds ?? 0`; `wouldCompleteRow = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9)`; `seeked = !last || Math.abs(pos - last.pos) > 30` (`STATE_DB_WRITE_INTERVAL_MS / 1000`; compared with the position at the **last write**, not the last beat); `shouldFlushDb = stateChanged || wouldCompleteRow || seeked || now - (last?.at ?? 0) >= 30_000`. Hence: first beat after boot/new key always writes; every beat inside the completion zone writes; a state change (`playing`<->`paused`<->`buffering`, only with presence) writes; otherwise one write per 30 s. Not flushing returns at once (rule 17).
14. On a flush, **before** the DB call: `map.set(dbKey, {at: now, pos})`, then every entry with `at < now - 300_000` (`30_000 * 10`) is deleted (the just-set entry survives). The entry is therefore set even when the write then fails (rule 15/18): the next ordinary beat within 30 s is debounced.
15. `playbackService.updateState(historyUserId, mediaId, {positionSeconds, durationSeconds, mediaFileId, episodeId})` is awaited and **not wrapped**: `!mediaId || !body.mediaFileId` (missing, `0`, `null`) -> 400 `mediaId and mediaFileId are required` (reached only on a flush, after rules 5-11 already ran and after the map entry was set). Otherwise: `state = findState(user, media, episodeId)` (movie row when `episodeId` falsy); `wasCompleted = state?.completed ?? false`; `dur = durationSeconds ?? 0`, `pos = positionSeconds ?? 0`; `completed = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9)` (same expression as rule 13); `watched = pos >= 5` (`HISTORY_MIN_WATCH_SECONDS`). Existing row: `positionSeconds = pos`; `durationSeconds = dur` only if `dur > 0`; `completed`; `hiddenFromContinueWatching = false`; `lastPlayedAt = now`; `playedAt = now` only if `watched` (else unchanged); `mediaFile = {id: body.mediaFileId}`; save. New row: `INSERT` with `positionSeconds = pos`, `durationSeconds = dur || 0`, `completed`, `lastPlayedAt = now`, `playedAt = watched ? now: null`, `episode = episodeId != null ? {id}: null`. After a successful save, when `completed && !wasCompleted`: `removeWatchedFromAutoPlaylists(userId, mediaId, episodeId != null ? [episodeId]: null)` inside its own try/catch (any failure -> warn `Playlist auto-remove failed for media #<id>: <msg>`, never propagated). Postgres FK violation `23503` on save (media row deleted by a library refresh mid-session, or an unknown `mediaFileId`) is swallowed: the method returns `null`; **every other error propagates** (500), including a unique violation `23505` from two concurrent first inserts.
16. `state` JSON shape: **existing row** = the row after save: scalar columns, `id`, `createdAt`, `updatedAt`, plus `userId, mediaId, mediaFileId, episodeId` as loaded (so `mediaFileId` is the **previous** file id when the file changed) **and** `mediaFile: {id}` set by the update; **new row** = `user:{id}`, `media:{id}`, `mediaFile:{id}`, `episode:{id}|null`, the scalar columns, `playedAt`, and the columns the database returns on insert (`id`, `createdAt`, `updatedAt`, `hiddenFromContinueWatching:false`), and **no** `userId/mediaId/mediaFileId/episodeId`. Both shapes are covered by parity (nulls of an absent `episodeId` as loaded).
17. **Response** (always 200): no flush and not `sessionLost` -> `null` returned -> the response has an **empty body** (`res.send`, no JSON `null`, no content-type); no flush and `sessionLost` -> `{"sessionLost":true}` (no `state` key); flush -> `{"state": <entity|null>}` or, when `sessionLost`, `{"sessionLost":true,"state":<entity|null>}` (`sessionLost` is never `false` in a body; `state` is `null` after a swallowed FK violation).

### Failure isolation matrix

18. What happens when each step throws or fails (no step other than those marked is wrapped in `try/catch`):

| Step | Failure | Effect on this response | Effect on later steps |
|---|---|---|---|
| numeric `:mediaId` check | non-numeric | 400, handler not run | all skipped |
| `SessionTokenGuard` | scoped token | 403 `session_token_required` | all skipped |
| engine beat, ownership | presence owner differs | 403 `Not your session` | all skipped; engine not called |
| engine beat, `EngineError` 403 | engine owner differs (or session unreadable by this owner) | 403 `Not your session` | all skipped |
| engine beat, any other error (incl. `getSession`/`restorePresence`) | engine down, 5xx, network | none (warn) | `engineLost = undefined`, registry path runs as if no engine |
| engine beat returns `sessionLost: true` | - | `sessionLost:true` in body | registry untouched, QoE and `remote.state` skipped, history still written (as `user.id`) |
| `registry.heartbeat` | unknown sid -> `null` | `sessionLost:true` (unless `engineLost === false`) | QoE and `remote.state` skipped |
| `parseSample` null / user mismatch | - | none | sample skipped, rest continues |
| `qoe.recordSample` / `updatePipelineOutput` | synchronous throw | **500** | `remote.state` and history skipped (not caught) |
| `events.emitToUser` | synchronous throw | **500** | history skipped (not caught) |
| debounce / map | cannot throw | - | - |
| `playbackService.updateState`, `!mediaFileId` | validation error | **400** | presence, QoE, emit already done; debounce entry already set |
| `updateState`, FK violation 23503 | swallowed -> `null` | `state:null` (200) | debounce entry set |
| `updateState`, other DB error | propagates | **500** | presence, QoE, emit already done; debounce entry already set (no retry for 30 s unless seek/state change/completion) |
| playlist auto-remove | any throw | none (warn, caught inside the playback service) | row already saved |

### Auto-playlist cleanup (`removeWatchedFromAutoPlaylists`)

19. `PlaylistsService.removeWatchedFromAutoPlaylists(userId, mediaId, episodeIds|null)`: returns immediately when `episodeIds != null && episodeIds.length === 0`; loads the user's own playlists with `autoRemoveWatched = true` (none -> return); deletes `playlist_items` of those playlists with `mediaId = $mediaId` and, for a movie (`episodeIds == null`), `"episodeId" IS NULL`, else `"episodeId" IN (episodeIds)`. Items in playlists owned by someone else, or in shared playlists the user does not own, are untouched.
20. `removeWatchedFromAutoPlaylists` has one call site, the private wrapper `autoRemoveFromPlaylists`, invoked by four playback methods: `updateState` (heartbeat), `toggleSeriesWatched`, `toggleSeasonWatched` and `toggleWatched`. The rule (and its isolation) is specified once here and reused by `playback-state.md`.

## SQL

Raw SQL is not used by this route; the route's database calls written as equivalent SQL:

1. `findState`: `SELECT * FROM playback_states WHERE "userId" = $1 AND "mediaId" = $2 AND ("episodeId" = $3 | "episodeId" IS NULL) LIMIT 1`.
2. Existing-row save (only changed columns plus `updatedAt` are updated): `UPDATE playback_states SET "positionSeconds" = $pos, ["durationSeconds" = $dur,] completed = $c, "hiddenFromContinueWatching" = false, "lastPlayedAt" = now, ["playedAt" = now,] "mediaFileId" = $mf, "updatedAt" = now WHERE id = $id`.
3. New-row save: `INSERT INTO playback_states ("userId","mediaId","mediaFileId","episodeId","positionSeconds","durationSeconds",completed,"lastPlayedAt","playedAt") VALUES ($u,$m,$mf,$ep|NULL,$pos,$dur,$c,$now,$played|NULL) RETURNING id, "createdAt", "updatedAt", "hiddenFromContinueWatching"`. Unique partial indexes: `idx_playback_user_movie ("userId","mediaId") WHERE "episodeId" IS NULL`, `idx_playback_user_episode ("userId","episodeId") WHERE "episodeId" IS NOT NULL`.
4. Auto-remove: `SELECT * FROM playlists WHERE "ownerId" = $1 AND "autoRemoveWatched" = true`; `DELETE FROM playlist_items WHERE "playlistId" IN ($ids) AND "mediaId" = $m AND ("episodeId" IS NULL | "episodeId" IN ($eps))`.

## Events

| Event | Audience | Payload | Emitter / consumer |
|---|---|---|---|
| `remote.state` | the request user's SSE connections + household fan-out | Rule 11 | emitted here each beat with a live target; consumed by remote controllers |

## Settings keys

`qoe_enabled` (`'false'` disables QoE calls of rule 10; see `qoe.md`). No other setting is read. Constants: debounce `30_000` ms, prune horizon `300_000` ms, seek threshold 30 s, completion window `dur - 30` s or 90 %, history threshold 5 s.

## Jobs/timers

none besides the debounce map (rule 14); the client beats every 10 s (comment).

## Vectors/parity

- No pure-logic vector set. The debounce/completion arithmetic and the response-body selection are covered by Rust unit tests: debounce of a plain 10 s tick, seek flush, `remote.state` every beat, no emit without target or unknown session, qoe bitrate fallback (served rung, client value kept, remux null, non-string quality), engine runtime (beat as owner, `sessionLost` without fan-out, foreign session refused before the engine, attributed user, engine 403 -> refusal, revived presence rebuilt, fallback to registry), and the history 5 s threshold.
- Parity scenarios (`server/parity/scenarios/playback/`): `heartbeat-no-session-first-beat` (body `{state}` shape), `heartbeat-debounced-empty-body`, `heartbeat-seek-flush`, `heartbeat-complete-flush`, `heartbeat-session-lost` (fake engine answers `sessionLost:true`), `heartbeat-foreign-session-403`, `heartbeat-stream-token-403`, `heartbeat-missing-media-file-400`, `heartbeat-bad-media-id-400`, `heartbeat-unauthenticated-401`, `heartbeat-auto-playlist-removal` (movie and episode). Ignore `$..createdAt`, `$..updatedAt`, `$..lastPlayedAt`, `$..playedAt`.

## Open questions

1. Rule 5 swallows a `getSession`/`restorePresence` failure as "engine could not be asked" and rule 18 leaves the debounce entry set after a failed write: preserve (parity) or fix?
2. Rule 9: `sessionLost` stays `false` when the engine says alive but presence cannot be rebuilt (snapshot 404 race): preserve?
