# Spec: QoE (playback quality of experience)

Core in `fliks_domain::qoe`, service and routes in `fliks-server`. Tables: `playback_qoe_sessions`, `playback_qoe_events` (`server/migrations/1786300000000_create-playback-qoe.sql`).

Related: the heartbeat's QoE sample step is `heartbeat.md` rule 10; presence and engine events feed the trackers (Rules 40-41).

## Routes

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/system/qoe/sessions` | JWT or API key; `Read Settings` | query `days?`, `verdict?`, `userId?`, `device?` (repeatable), `limit?`, `offset?` (all strings, rule 1; no DTO) | `{ items: QoePlayback[], total: number }` (rule 24) | 401/403 | none |
| `GET /api/system/qoe/sessions/:sessionId` | same | path `sessionId` string | `{ ...QoePlayback, sessions: PlaybackQoeSession[], events: {id,sessionId,at,type,data}[] }` (rule 25) | 404 `qoe_session_not_found` (`{statusCode:404, message:"qoe_session_not_found", error:"Not Found"}`) | none |
| `GET /api/system/qoe/summary` | same | query `days?` | `{ byVerdict: Record<verdict, number>, byDevice: QoeDeviceSummary[] }` (rule 26) | 401/403 | none |
| `POST /api/playback/sessions/:sessionId/events` | JWT or API key, session-token guard (scoped stream/cast token -> 403 `session_token_required`); no policy | path `sessionId` string; body inline `{ events?: unknown, playbackId?: unknown, sentAt?: unknown }` (not validated) | 204, empty body, in every non-error case (also for an unknown session, a disabled feature or invalid events) | 403 `Not your session` | tracker events (rules 28, 32) |

Live TV also has a QoE-carrying heartbeat, `PUT /api/livetv/sessions/:sessionId/state` (rule 41).

## Rules

### Admin controller

1. Query parsing: `int(v)` = `Math.trunc(Number(v))` when `v` is non-empty and `Number(v)` is finite, else `undefined`. `days = min(max(int(days) ?? 7, 1), 3650)` (controller) and the service clamps again to `[1, 3650]`. `verdict` is kept only if it is one of `ok, network, device, server, error`, otherwise silently ignored (no 400). `userId = int(userId)` clamped to `[-2^31, 2^31-1]` (an out-of-range id matches nothing instead of failing the int column). `device`: one value or repeated values (`?device=a&device=b`; commas are not separators because user agents contain commas); only strings of length `<= 512` are kept, at most the first 50. `limit = int(limit)`, `offset = int(offset)`; the service applies `limit = min(max(limit ?? 50, 1), 200)` and `offset = max(offset ?? 0, 0)`.
2. `GET sessions/:sessionId` answers 404 `qoe_session_not_found` when no row has that `sessionId`.

### Pure core: validation

3. `MAX_EVENTS_PER_REQUEST = 50`. Helpers: `num(v)` = finite number `>= 0` else `null`; `int(v)` = `num` then `min(round(v), 2^31-1)` (JS `Math.round`: halves toward +inf); `ms(v)` = `num` capped at 86 400 000; `str(v, max)` = string with every `\u0000` removed, truncated to `max` chars, `null` when empty or not a string; `bool(v)` = boolean else `null`.
4. `parsePlaybackId(v)`: string matching `^[A-Za-z0-9_-]{1,64}$` else `null`. `parseSentAt` = `num`.
5. `parseSample(raw)` -> `QoeSample | null`: `null` unless `raw` is a plain object (not array) whose `engine` is one of `shaka, exoplayer, avplayer, mpv, avplay, webos, cast`. Output keys exactly: `engine`; `cmcd: raw.cmcd === true`; `droppedFrames`, `decodedFrames` = `int`; `bandwidthBps`, `bufferAheadS`, `variantBitrate` = `num`; `width`, `height` = `int`; `videoCodec = str(…,64)`; `decoderName = str(…,128)`; `hwDecoder = bool`; `stallCount = int ?? 0`; `stallMs = int(ms(v)) ?? 0`; `recoveryReloads = int ?? 0`; `playbackId = parsePlaybackId`. Unknown fields dropped.
6. `parseEvents(raw, now = Date.now(), sentAt = null)` -> `QoeEvent[]`: `[]` unless an array; only the first 50 elements are examined; an element is kept only when it is a plain object with `type` in `stall, error, recovery, quality_switch, reload`. `skew = sentAt != null && |now - sentAt| <= 86 400 000 ? now - sentAt : 0`. `at`: `num(e.at)` (+ `skew`) when within a day of `now`, else `now`. `position = num(e.position)` (key always present, `null` allowed). Optional keys, present only when valid: `durationMs = ms`, `bufferAheadS = num`, `bandwidthBps = num`, `code` (any finite number, negatives allowed), `message = str(…,300)`, `category = str(…,64)`, `fromBitrate`, `toBitrate`, `variantBitrate` = `num`. `recovery`: `reason` in `session_lost, session_expired, stall, other` else `'other'`. `reload`: `reason` in `audio, subtitles, quality, remux_fallback, other` else `'other'`, plus `from`, `to` = `str(…,80)` when non-empty.

### Pure core: CMCD

7. `readCmcdRaw(raw)`: parse `raw` as an RFC 8941 Structured Field **Dictionary**; any parse failure -> `null`; then pick (rule 9). `readCmcd(req)`: first, when `req.query.CMCD` is a non-empty **string**, parse it (a repeated/array or empty value is ignored and the headers are tried next; the query wins over headers); else, when any of the request headers `cmcd-request`, `cmcd-object`, `cmcd-session`, `cmcd-status` is truthy, gather every header whose lower-case name starts with `cmcd-` (array values joined with `,`) and decode the four fields in the fixed order **Object, Request, Session, Status** (empty fields skipped), each as a dictionary, merging keys with later fields overriding earlier ones; a failure in any field (or a header value the platform `Headers` rejects) -> `null`. All errors are swallowed (a malformed value never fails a segment request).
8. RFC 8941 dictionary semantics: keys match `[a-z*][a-z0-9_.*-]*` (an upper-case key is an error); a bare key is Boolean `true`; `key=item` where item is integer (max 15 digits, `-` allowed), decimal (max 3 fractional digits, max 12 integer digits), string (`"…"`), token, byte sequence (`:…:`), Boolean (`?0`/`?1`) or inner list `(…)`; parameters `;k=v` turn the value into an item-with-parameters; members separated by `,` with optional spaces/tabs around (`bl=1 , mtp=2` ok); a **duplicate key keeps the last value**; leading/trailing spaces ok; empty or blank input = empty dictionary; **any** syntax error fails the whole dictionary (`bl=1,` trailing comma, `bl=1,,mtp=2`, `bl=1;`, `BL=1`, `mtp=1e3`, `bl=0x10`, `bl=1.1234`, a 16-digit integer). Tokens and strings both reduce to a plain string (`ot=v` and `ot="v"` are equal).
9. Pick: `bl`, `mtp`, `br` are kept only when the reduced value is a JS **number** (integer or decimal) that is finite and `>= 0` (so `bl=-5`, `bl="1"`, `bl=?1`, `bl=(1 2)`, byte sequences and **any value carrying parameters** such as `bl=100;x=1` are dropped; `-0` becomes `0`); `ot` is kept only when it reduces to the string `v`, `a` or `av`. Empty result -> `null`. Units: `bl` ms, `mtp`/`br` kbps.

### Pure core: stall classification

10. Constants: `SKEW_MARGIN_MS = 5000`, `SERVER_WAIT_MS = 1000`, `STARVED_S = 1`, `HEADROOM = 1.2`, `DROPPED_BURST_RATIO = 0.1`, `MIN_BURST_FRAMES = 30`; from `diagnose.ts`: `SERVER_SPEED_FLOOR = 1.0`, `LIVE_SERVER_SPEED_FLOOR = 0.9`. `speedOf(seg) = segmentDurationS * 1000 / max(waitedMs ?? 1, 1)`.
11. `classifyStall(stall, ctx)` -> `{cause, confidence, reason, evidence, hints}`; first matching rule wins. `start = stall.at - (durationMs ?? 0)`; `buffer = stall.bufferAheadS ?? ctx.bufferAheadS`, `bandwidth = stall.bandwidthBps ?? ctx.bandwidthBps`, `bitrate = stall.variantBitrate ?? ctx.variantBitrate`; `evidence` starts with `bufferAheadS`, `bandwidthBps`, `variantBitrate` when non-null. `reason` is always `qoe.stall.<name>`.
12. **Rule 1 server wait**: `serverHit(segments, lo, hi, live)` = among segments with `waitedMs != null && s.at >= lo && s.at - s.waitedMs <= hi` pick the one with the largest wait (`worst`, first on ties by `>`), `median` = element at index `len >> 1` of the ascending speeds of all hits; slow = `median < (live ? 0.9 : 1.0)`; a hit counts when `(!live && worst.waitedMs > 1000) || slow`, giving `{waitedMs, transcodeSpeed: speedOf(worst)}`. Strict window `[start, at]` first (confidence `high`); if none, the window widened by 5000 ms both sides (`low`). The rule fires only when a hit exists and `buffer == null || buffer < 1` (a wait with data buffered is ffmpeg paused ahead, not starvation): evidence gains `waitedMs`, `transcodeSpeed`; cause `server`, reason `server_wait`, `hints` from `serverHints`.
13. `serverHints` (never change the verdict): `software_encode` when `pipeline.encode` exists and `!hw`; `burn_in` when `pipeline.burnIn` is truthy; `cpu_tonemap` when `pipeline.tonemap === 'cpu'`; `busy` when `load.activeTranscodes >= 2` (and then `evidence.activeTranscodes = n`); each emitted as `qoe.stall.hint_<name>` in that order.
14. Remaining rules after a miss: `starved = buffer != null && buffer < 1`; `lowThroughput = bandwidth != null && bitrate != null && bandwidth < 1.2 * bitrate`. (2) `starved && lowThroughput` -> `network`, `high`, `network_starved`. (3) `droppedBurst(start, ctx)` (the last sample with `at <= start` versus the **last** sample: needs both, `after.at > before.at`, all four counters non-null, `decoded >= 30`, `dropped >= 0`; ratio `dropped/decoded`) `>= 0.1` -> evidence `droppedPct = ratio * 100`, `device`, `starved ? 'low' : 'high'`, `device_dropped_frames`. (4) `buffer != null && !starved` -> `device`, `high`, `device_buffer_ahead`. (5) `starved` -> `network`, `low`, `network_unconfirmed`. (6) `lowThroughput` -> `network`, `low`, `network_low_throughput`. (7) else `unknown`, `low`, `unknown`.

### Pure core: diagnosis

15. Constants: `MIN_WATCHED_MS = 60 000`, `STALLS_PER_10_MIN = 1`, `STALL_RATIO = 0.01`, `STARVED_BUFFER_S = 1`, `BANDWIDTH_HEADROOM = 1.2`, `DROPPED_RATIO = 0.05`, `MIN_DECODED_FRAMES = 300`. `result(verdict, confidence, ...reasons)` prefixes each reason `qoe.reason.`.
16. `diagnose(summary, live=false)` = `decide(...)` plus: when `summary.cmcdClaimed && !summary.cmcd`, push `qoe.reason.cmcd_missing`. First match in `decide`: (1) `unrecoveredError` -> `error`, `high`, `fatal_error`. (2) `stalling = stallCount > 0 && (stallCount / (watchedMs / 600000 || Infinity) >= 1 || stallMs / max(watchedMs,1) >= 0.01)`; when stalling: (2a) `fromCauses` result if any; (2b) `medianTranscodeSpeed != null && < (live ? 0.9 : 1.0)` -> `server`, `high`, `stalls_server_slow`; (2c) `buffer = stallBufferAheadS`, `starved = buffer == null || buffer < 1`; starved: `tp = stallBandwidthBps ?? avgBandwidthBps ?? cmcdThroughputBps`, `bitrate = avgVariantBitrate`; either null -> `network`, `low`, `stalls_starved_no_throughput`; else `confidence = buffer != null ? 'high' : 'low'`; `tp < 1.2*bitrate` -> `network`, confidence, `stalls_starved_low_throughput`; else `network`, `low`, `stalls_starved_bandwidth_ok`; not starved -> `device(s,'high','stalls_buffer_ahead')`. (3) not stalling: `dropped = droppedFrames != null && decodedFrames != null && decodedFrames >= 300 && droppedFrames/decodedFrames >= 0.05` -> `device(s,'high','dropped_frames')`. (4) else `ok`, `confidence = watchedMs >= 60000 && (sampleCount > 0 || cmcd) ? 'high' : 'low'`, `healthy` (a short playback is healthy at low confidence; migration `qoe-drop-unknown-verdict` rewrote the stored `unknown` rows). `device(s, conf, reason)` appends `software_decoder` when `hwDecoder === false && (height ?? 0) >= 720`.
17. `fromCauses(s)`: `null` without `stallCauseMs`; `total = server+network+device+unknown`; the cause with the largest ms (ties: first in order `server, network, device, unknown`, replaced only by strictly greater); `unknown` winning -> `null` (falls through to 2b); `confidence = top/total > 0.5 ? 'high' : 'low'`; reason = `dominantReason`: the heaviest `stallReasonMs` entry whose key starts with `qoe.stall.<cause>_` mapped by `{server_wait: stalls_server_slow, network_starved: stalls_starved_low_throughput, network_low_throughput: stalls_starved_low_throughput, network_unconfirmed: stalls_starved_bandwidth_ok, device_buffer_ahead: stalls_buffer_ahead, device_dropped_frames: dropped_frames, server_session_lost: session_lost, server_session_expired: session_expired}`, else the cause default `{server: stalls_server_slow, network: stalls_starved_low_throughput, device: stalls_buffer_ahead}`; device causes go through `device()`.

### Pure core: aggregation

18. Constants: `MAX_WATCH_GAP_MS = 30 000`, `MIN_SPEED_SAMPLES = 3`, `MAX_SAMPLE_AGE_MS = 15 000`, `MAX_KEPT = 200` (list cap, oldest dropped), `MAX_SEGMENTS = 300`, `MAX_SAMPLES = 20`. `median` of an even count = mean of the two middle values; `avg` = arithmetic mean.
19. `ResettingCounter`: `add(null)` is ignored; a value lower than the previous one means the engine reloaded: the previous value is added to `base`; `total = base + last`, or `null` before any value. Used for `droppedFrames`, `decodedFrames`, `stallCount`, `stallMs`, `recoveryReloads`.
20. `addSample(s, now, playing = true)`: if a previous sample exists and `playing`, `watchedMs += min(now - lastSampleAt, 30000)`; `lastSampleAt = now`; clears `errorOpen`; `sampleCount++`; `engine = s.engine`; `s.cmcd` sets `cmcdClaimed`; pushes `{at: now, droppedFrames, decodedFrames}` to the 20-entry sample ring; feeds the five counters; non-null `videoCodec/width/height/decoderName/hwDecoder` overwrite; non-null `bandwidthBps` sets the latest value, appends to `bandwidths` and lowers `minBandwidth`; non-null `variantBitrate` sets the latest and appends; non-null `bufferAheadS` sets the latest and `bufferAheadAt = now`.
21. `addEvent(e, now, {live, load})` -> classification or `null`: a **freeze** is `type === 'stall'` or (`type === 'recovery'` and `durationMs > 0`). For a freeze: `buffer = e.bufferAheadS ?? (bufferAheadAt within 15 s of now ? latest buffer : null) ?? (cmcdBufferAt within 15 s ? cmcdBuffer : null)`; non-null `buffer` is appended to `stallBuffers`, `e.bandwidthBps` to `stallBandwidths`; classification = `recoveryCause(e)` for a recovery (`session_lost` -> server/high/`qoe.stall.server_session_lost`, `session_expired` -> server/low/`qoe.stall.server_session_expired`, empty evidence and hints, else `null`), otherwise (or when null) `classifyStall(e, {live, load, pipeline, segments, samples, bufferAheadS: buffer, bandwidthBps: bandwidth ?? cmcdBandwidth, variantBitrate})`. Weight `w = max(durationMs ?? 0, 1) * (confidence === 'low' ? 0.5 : 1)` is added to `causeMs[cause]` and `reasonMs[reason]` (both created on first freeze); `last = {at: e.at, durationMs ?? 0, cause, reason}`. `error` events: `errorCount++`, `errorOpen = true`; `recovery` events clear `errorOpen`.
22. `addSegment(m, now = Date.now())`: append `{at: now, segmentDurationS, waitedMs}` (cap 300); when `waitedMs != null && segmentDurationS > 0` append speed `segmentDurationS*1000/max(waitedMs,1)` (cap 200). `addCmcd(c, now = Date.now())`: `cmcdSeen = true`; `bl` counts as buffer (`bl/1000` s) unless `ot === 'a'`; `mtp` appends `mtp*1000` to the CMCD throughput list and sets `cmcdBandwidth`; `br` sets `variantBitrate = br*1000` only while no sample has provided a variant bitrate.
23. `summary()` fields: `engine, cmcd (cmcdSeen), cmcdClaimed, videoCodec, width, height, decoderName, hwDecoder, watchedMs, stallCount (total ?? 0), stallMs (total ?? 0), droppedFrames, decodedFrames (null before any), recoveryReloads (total ?? 0), errorCount, unrecoveredError (errorOpen), bandwidthBps, variantBitrate, bufferAheadS, avgBandwidthBps, minBandwidthBps, avgVariantBitrate (avg(list) ?? latest), stallBufferAheadS (median), stallBandwidthBps (median), cmcdThroughputBps (avg), medianTranscodeSpeed (median, null below 3 speeds), sampleCount, stallCauseMs (copy or null), stallReasonMs (copy or null)`. `mergeSummaries(parts)` (parts oldest first; one part returns itself): counters sum; `engine/videoCodec/width/height/decoderName/hwDecoder` = latest non-null; `cmcd`, `cmcdClaimed` = any; frames sum only over parts having both counters (else null/null); `unrecoveredError`, `bandwidthBps`, `variantBitrate`, `bufferAheadS` from the last part; `avgBandwidthBps`, `avgVariantBitrate`, `cmcdThroughputBps`, `medianTranscodeSpeed` weighted by `max(watchedMs,1)` (null parts skipped); `stallBufferAheadS`, `stallBandwidthBps` weighted by `max(stallCount,1)`; `minBandwidthBps` = min; `stallCauseMs`/`stallReasonMs` summed (null when no part has them).

### Admin reads (service)

24. `listSessions`: one SQL query groups rows into **playbacks** (key rule 27), filtered and paged; a second query loads all rows of those playbacks; rows are re-grouped, each group sorted by `startedAt` ASC, merged with `mergeSummaries(rowSummary)` and re-diagnosed with `diagnose(merged, last.playMethod === 'live')`; groups sorted by `lastSeenAt` DESC. `QoePlayback` = the **last** row of the group minus `stallBufferAheadS, stallBandwidthBps, cmcdThroughputBps, unrecoveredError, sampleCount, stallCauseMs, stallReasonMs`, with: `sessionId` = last row's, `sessionIds` = all ids oldest first, `startedAt` = first row's, `lastSeenAt` = max, and from the merged summary `engine, cmcd, cmcdClaimed, videoCodec, width, height, decoderName, hwDecoder, watchedMs, stallCount, stallMs, droppedFrames, decodedFrames, avgBandwidthBps, minBandwidthBps, avgVariantBitrate, recoveryReloads, errorCount, medianTranscodeSpeed`, and `verdict, confidence, reasons` from the new diagnosis. Other keys come from the last row as stored (`playbackId, userId, mediaFileId, mediaTitle, endedAt, deviceLabel, systemName, appVersion, playMethod, quality, transcodeReasons, pipeline, playbackVerdict, playbackConfidence`). `rowSummary` sets `bandwidthBps`, `variantBitrate`, `bufferAheadS` to `null`.
25. `getSession(sessionId)`: `null` when no row; anchor row, then all rows with the same `(userId, playbackId)` when both are non-null else just the anchor; rows sorted by `startedAt` ASC; events of all those sessions ordered `at ASC, id ASC`; answer `{ ...mergePlaybacks(rows)[0], sessions: rows (raw entity columns), events: [{id, sessionId, at, type, data}] }`.
26. `summary(days)`: one grouped query (below) then in memory: `byVerdict` starts with all five verdicts at `0` and counts one per playback by `MAX(playbackVerdict)`; `byDevice` groups playbacks by `(device ?? '', engine ?? '')` (`\u0000`-joined) and yields per group `{device, systemName, engine}` of the **first** playback in the group (rows are newest first), `sessions` = group size, `stallSessions` = playbacks with `stalls > 0`, `avgDroppedPct` = mean of per-playback `dropped/decoded*100` over those with both sums (null when none; `decoded = 0` counts as null), `hwDecoderPct` = share of playbacks with non-null `hw` that are `true`, `topVerdict` = most frequent verdict, ties by first occurrence in descending-count stable order; groups sorted by `sessions` DESC (stable).
27. Playback key: `COALESCE(userId::text || ':' || playbackId, sessionId)` (a playbackId is unique only per user; a row without user or playbackId is its own playback). In memory `playbackKey(r)` = `userId:playbackId` when both non-null else `sessionId`. Window: `floor = now - days*86400000 - 86400000` bounds the scan on rows, `since = now - days*86400000` filters groups by `MAX(lastSeenAt)`; days clamped `[1,3650]`.

### Ingest endpoint

28. `POST sessions/:sid/events` order: (1) `qoe.enabled` false -> 204; (2) `live = registry.peek(sid) ?? qoe.trackedSession(sid)` (an ended session whose tracker is kept still takes events: the exit flush races `DELETE /api/stream/sessions/:id`); none -> 204; (3) `live.userId !== user.id && live.attributedUserId !== user.id` -> 403 `Not your session`; (4) `qoe.recordEvents(live, parseEvents(body?.events, Date.now(), parseSentAt(body?.sentAt)), parsePlaybackId(body?.playbackId))`; 204. `body` missing is tolerated (`body?.`).

### Service: trackers, flush, purge

29. `QoeService` keeps `Map<sessionId, Tracker>` in memory; a `Tracker` = `{session (SessionRef), playbackId, agg, pendingEvents[], eventCount, dirty, reported, endedAt, touchedAt, flushing, flushAgain, failures}`. `SessionRef` = presence-shaped (`sessionId, userId, mediaTitle, startedAt, lastBeat, deviceLabel, systemName, appVersion, quality, transcodeReasons, state, attributedUserId, mediaFileId: number|null, kind: 'transcode'|'remux'|'directplay'|'live'`).
30. Enabled flag: `enabledFlag = false` until the `qoe_enabled` setting is read (boot) -> `settings.get(key) !== 'false'` (unset means enabled; a failed read leaves it `false`); a settings-change listener for that key re-reads it. While `false`, `track()` returns `null` and every `register/recordSample/recordEvents/setPipeline/observeServed/noteServedRung/noteHwAccel/updatePipelineOutput` is a no-op; `liveSummary` still answers for trackers created earlier.
31. `track(session, revive = true)`: create the tracker on first use; always `t.session = session`, `dirty = true`, `touchedAt = now`; `revive` clears `endedAt` (so `recordEvents`, `setPipeline`, `recordProduction` pass `revive = false`, `register`, `recordSample` and `observeServed` revive). `register(session)` only tracks: **no row is written until a sample or event arrives** (`reported`).
32. `recordSample(session, sample)`: `reported = true`; `playbackId = sample.playbackId ?? t.playbackId`; `agg.addSample(sample, Date.now(), session.state !== 'paused')`. `recordEvents(session, events, playbackId = null)`: `reported = true`; `playbackId = playbackId ?? t.playbackId`; `load = serverLoad()` computed once only when the batch contains a freeze (stall or recovery with `durationMs > 0`); for each event `addEvent(e, now, {live: session.kind === 'live', load})`; **the per-session cap of 200 stored events** skips storing further rows (events still count in the summary); a stored row is `{sessionId, at: new Date(e.at), type, data}` with `data` = the event minus `type`/`at`, plus, when classified, `cause, causeConfidence, causeReason, causeEvidence, causeHints, serverLoad` (`serverLoad` may be `null`).
33. `serverLoad()` = `{activeTranscodes: loadProbe().activeTranscodes + sum(transcodeProbes), activeSessions: loadProbe().activeSessions, loadAvg1: os.loadavg()[0] (null on Windows), cpuCount: os.cpus().length}`; any throw -> `null`. The streaming side registers the probe: `activeTranscodes` = the engine job set size, `activeSessions` = presence count; live TV adds its transcode holds.
34. `setPipeline(session, p)` replaces the pipeline (`revive = false`). `updatePipelineOutput(session, quality, bitrate)`: no-op when disabled, untracked, no pipeline or no `pipeline.output`, or unchanged; else replaces `output.quality/bitrate`, `dirty = true`. `noteServedRung(session, quality, bitrate)`: no-op when disabled or `quality === 'auto'` or untracked; updates `output.quality` and, when `bitrate != null`, `output.bitrate`, only when something differs. `noteHwAccel(session, hw)`: only for `hw === 'none'` on a tracker whose pipeline has a hardware encode or decode: both stages become `{hw:false, kind:'cpu', name:null}` and a non-null `tonemap` becomes `'cpu'`.
35. `observeServed(session|null, cmcd|null, segmentDurationS, waitedMs)`: no-op when `session` is null or disabled; revives the tracker; `cmcd` -> `agg.addCmcd`; `agg.addSegment({segmentDurationS, waitedMs: waitedMs != null && waitedMs >= 20 ? waitedMs : null})` (`MIN_WAIT_MS = 20`: a shorter wait means the segment was already on disk). Callers: engine `SegmentServed` events (`segmentDurationS = realSegmentSeconds(segmentDuration setting, sourceFps)`), `PipelineChanged` (`noteServedRung` for a `transcode` presence with the rung bitrate from `servedRungBitrate`, `noteHwAccel`), and live TV `SegmentServed`. `recordProduction` and `observeSegment` (request-based) have no non-test caller: do not port.
36. `liveSummary(sid)`: `null` when untracked; else `{...diagnose(summary, kind === 'live'), stallCount, stallMs, droppedPct (dropped/decoded*100, null when decoded is 0/null), bandwidthBps: summary.bandwidthBps ?? summary.cmcdThroughputBps, variantBitrate, bufferAheadS, hwDecoder, decoderName, transcodeSpeed: medianTranscodeSpeed, engine, cmcd, cmcdClaimed, playbackId, lastStall}`; used by `GET /api/system/streams`. `sessionEnded(session)`: `endedAt = now`, `dirty = true`, flush (not awaited); the tracker stays for late events and revival. `trackedSession(sid)` returns the stored `SessionRef`.
37. **Flush** (`flush(t)`): returns at once when `!dirty || !reported`; a flush requested during one in flight sets `flushAgain` and joins it, and runs once more afterwards. A flush sets `dirty = false`, takes all `pendingEvents`, then in one `try`: build the row (`toRow`); when `userId` and `playbackId` are both set, `mergeVerdict` (SQL below) sets `playbackVerdict`/`playbackConfidence` of the row from the merge of its siblings and this row and reports whether a sibling's stored verdict differs; **upsert** the session row on `sessionId`; if siblings were stale, `restateSiblings` (SQL below); insert the events; `failures = 0`. On error: events are put back in front of `pendingEvents`, `dirty = true`, warn; after 5 consecutive failures (`MAX_FLUSH_FAILURES`) the tracker is dropped with its events.
38. `toRow`: `lastSeenAt = endedAt ?? max(session.lastBeat, touchedAt)`; `endedAt` null until `sessionEnded`; `playMethod = session.kind`; `quality = session.quality ?? pipeline.output.requested ?? null`; `transcodeReasons = session.transcodeReasons ?? []`; int columns clamped to `[0, 2^31-1]` via `round`; `verdict/confidence/reasons` from `diagnose(summary, kind === 'live')`; `playbackVerdict/playbackConfidence` default to the same (overwritten by `mergeVerdict`); `pipeline`, `stallCauseMs`, `stallReasonMs`, `unrecoveredError`, `sampleCount` as in the summary; `mediaFileId` null for live TV.
39. **Timers**: a 30 s timer runs `sweep()`: for each tracker in map order, `await flush` when dirty; then delete the tracker when `now - touchedAt > TRACKER_IDLE_MS` and (`!dirty || !reported`). `TRACKER_IDLE_MS = STREAM_SESSION_REVIVE_TTL_MS (default 900 000) + 60 000`, read once at module load. `onModuleDestroy` clears the timer and flushes every tracker. `@Cron(EVERY_DAY_AT_4AM)` (`0 4 * * *`, process timezone) `purgeOld()`: `days = Number(setting qoe_retention_days)` when finite and `> 0` else 30; `DELETE FROM playback_qoe_sessions WHERE "lastSeenAt" < now - days*86400000`; events go by `ON DELETE CASCADE`; logs `purged <n> qoe session(s)` when `affected`.

### Producers and consumers elsewhere

40. Presence creation registers the tracker (`qoe.register(live)` + `setPipeline`, `playback-info.md` rule 16); `LiveSessionRegistry.stop` calls `sessionEnded`; the heartbeat calls `recordSample`/`updatePipelineOutput` (`heartbeat.md` rule 10); the admin streams list calls `liveSummary`.
41. Live TV uses the same service in-process: `register(ref)` and `setPipeline(ref, toQoePipeline(res.qoePipeline))` at open, `recordSample({...ref, state}, parseSample(body.qoe))` on `PUT /livetv/sessions/:sid/state` (only when `body.qoe != null` and the sample parses; `state` is `'paused'` or else `'playing'`; ownership checked by the live TV route: 404 `Live TV session not found`, 403 `Not your session`), `observeServed(ref, readCmcdRaw(cmcdRaw), segmentSeconds, waitedMs)` on `SegmentServed`, `sessionEnded(ref)` on viewer drop, `addTranscodeProbe(() => holds in transcode mode)`. The ref is `{sessionId, userId, mediaFileId: null, mediaTitle: channelName, startedAt, lastBeat: now, deviceLabel: userAgent, systemName: null, appVersion: null, kind: 'live', quality: null, transcodeReasons: [], state: 'playing', attributedUserId: null}`.

## SQL

Tables: `playback_qoe_sessions` (PK `sessionId varchar(64)`; indexes `IDX_playback_qoe_sessions_last_seen (lastSeenAt)`, `..._playback_verdict (playbackVerdict)`, `..._device (deviceLabel)`, `..._playback (userId, playbackId)`) and `playback_qoe_events` (`id serial`, `sessionId` FK `ON DELETE CASCADE`, `at timestamptz`, `type`, `data jsonb`, index on `sessionId`); columns per the entities. `KEY` below is `COALESCE(s."userId"::text || ':' || s."playbackId", s."sessionId")` (`KEY_SQL`).

1. **List page** (optional filters ANDed):
```sql
SELECT KEY AS key, MAX(s."lastSeenAt") AS last, MAX(s."userId") AS uid,
       MAX(s."playbackId") AS pid, COUNT(*) OVER() AS total
FROM playback_qoe_sessions s
WHERE s."lastSeenAt" >= $floor
  [AND s."playbackVerdict" = $verdict]
  [AND s."userId" = $userId]
  [AND s."deviceLabel" IN ($devices...)]
GROUP BY KEY
HAVING MAX(s."lastSeenAt") >= $since
ORDER BY last DESC
LIMIT $limit OFFSET $offset
```
`total` (a bigint, read as string and `Number()`-ed) is the number of groups after `HAVING`, repeated on every row; `0` when the page is empty (also when `offset` is past the end).
2. **Rows of the page's playbacks** (`sids` = the page keys, `uids`/`pids` = the grouped playbacks' `uid`/`pid`, only rows with both non-null):
```sql
SELECT s.* FROM playback_qoe_sessions s
WHERE s."sessionId" = ANY($sids)
   OR (s."userId" = ANY($uids) AND s."playbackId" = ANY($pids))
```
The two `ANY` lists also match cross pairs of different playbacks; the code keeps only rows whose `playbackKey(row)` is one of the page keys.
3. **Session anchor and siblings**: `SELECT * FROM playback_qoe_sessions WHERE "sessionId" = $1 LIMIT 1`; `SELECT * FROM playback_qoe_sessions WHERE "userId" = $1 AND "playbackId" = $2`; `SELECT * FROM playback_qoe_events WHERE "sessionId" IN (...) ORDER BY "at" ASC, id ASC`.
4. **Summary** (`latest(col)` = `(ARRAY_AGG(s."col" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."col" IS NOT NULL))[1]`; `both(col)` = `SUM(CASE WHEN s."droppedFrames" IS NOT NULL AND s."decodedFrames" IS NOT NULL THEN s."col" END)`):
```sql
SELECT KEY AS key, MAX(s."lastSeenAt") AS last,
       latest(deviceLabel) AS device, latest(systemName) AS "systemName",
       latest(engine) AS engine, latest(hwDecoder) AS hw,
       MAX(s."playbackVerdict") AS verdict, SUM(s."stallCount") AS stalls,
       both(droppedFrames) AS dropped, both(decodedFrames) AS decoded
FROM playback_qoe_sessions s
WHERE s."lastSeenAt" >= $floor
GROUP BY KEY
HAVING MAX(s."lastSeenAt") >= $since
ORDER BY last DESC
```
`stalls`, `dropped`, `decoded` are bigint/numeric strings, `Number()`-ed in code; `MAX(playbackVerdict)` is the alphabetical maximum of the varchar (rows of one playback share a verdict once restated).
5. **Flush upsert**: `INSERT INTO playback_qoe_sessions (<all entity columns>) VALUES (...) ON CONFLICT ("sessionId") DO UPDATE SET <every column except "sessionId" = EXCLUDED.col>` (every column of the built row, nulls included). Events: `INSERT INTO playback_qoe_events ("sessionId","at","type","data") VALUES (...), ...` (one multi-row insert; `data` jsonb; `id` serial).
6. **Sibling verdict read**: `SELECT * FROM playback_qoe_sessions WHERE "userId" = $1 AND "playbackId" = $2 AND "sessionId" <> $3`.
7. **Sibling restate**:
```sql
UPDATE playback_qoe_sessions
SET "playbackVerdict" = $v, "playbackConfidence" = $c
WHERE "userId" = $u AND "playbackId" = $p AND "sessionId" <> $sid
  AND ("playbackVerdict" IS DISTINCT FROM $v OR "playbackConfidence" IS DISTINCT FROM $c)
```
8. **Purge**: `DELETE FROM playback_qoe_sessions WHERE "lastSeenAt" < $cutoff`.

`mergeVerdict` merges `[...siblings, row]` through `mergePlaybacks` (rules 24, 27) and takes `[0]`'s `verdict`/`confidence`; with no siblings the row keeps its own diagnosis and no restate happens.

## Events

none (QoE emits no SSE or domain event; it is read by REST and by `liveSummary`).

## Settings keys

| key | default / parsing |
|---|---|
| `qoe_enabled` | enabled unless the value is exactly `'false'` |
| `qoe_retention_days` | `Number(v)` finite and `> 0`, else 30 |

Env: `STREAM_SESSION_REVIVE_TTL_MS` (tracker idle window, see rule 39).

## Jobs/timers

| Job | Schedule | Behaviour |
|---|---|---|
| tracker sweep + flush | every 30 s | rule 39 |
| purge | daily at 04:00 | rule 39 |
| exit flush | on `sessionEnded` and shutdown | rule 36, 39 |

## Vectors/parity

- Vector set `qoe`: `server/fixtures/qoe/cases.json` (inputs are JSON, so `Infinity`/`-0`/`undefined` follow JSON): 359 cases: `classifyStall` 91, `diagnose` 102, `aggregate` 52 (input `{steps:[{op:'sample'|'event'|'segment'|'cmcd'|'pipeline', ...}]}`, expected `{results, summary, lastStall, pipeline}`), `merge` 14, `parseEvents` 43, `parsePlaybackId` 4, `parseSample` 21, `readCmcd` 18, `readCmcdRaw` 14. Replay tests in `crates/domain/tests/qoe.rs`; `BLESS=1` rewrites `expected`.
- Extra Rust unit cases for the RFC 8941 parser beyond the fixture (rule 8 list): `bl=1.5`, `bl=100;x=1`, `BL=1`, `ot="v"`, `bl=1 , mtp=2`, `bl=1,`, `bl=1.1234`, `bl=1,bl=2`, `bl=?1`, `bl=-0`, 15- and 16-digit integers, `bl=1;`.
- Not covered by vectors: the service (trackers, flush, merge verdict, purge, `liveSummary`), the SQL of rules 24-27 and the routes: Rust tests cover them; parity scenarios (`server/parity/scenarios/qoe/`): `qoe-events-204`, `qoe-events-unknown-session-204`, `qoe-events-foreign-403`, `qoe-events-stream-token-403`, `qoe-events-unauthenticated-401`, `qoe-sessions-list`, `qoe-sessions-list-filters` (verdict, userId, repeated device, days clamp, limit/offset), `qoe-sessions-forbidden-403`, `qoe-session-detail`, `qoe-session-not-found-404`, `qoe-summary`, `qoe-summary-days-clamp`, with the seed holding sessions of one playback across several sids. Ignore `$..at`, `$..startedAt`, `$..lastSeenAt`.

## Open questions

1. `GET /api/system/qoe/summary` uses `MAX(playbackVerdict)` (alphabetical) for a playback: keep as is (rule 26) even though it only matters for playbacks whose rows disagree.
