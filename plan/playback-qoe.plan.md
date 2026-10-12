# Playback QoE telemetry: why does this client stutter?

Every client reports how its playback goes; the server diagnoses each viewing
(network, device, server, error) and the admin sees it live in
`/admin/streams` and over time in `/admin/playback-quality`.

## 0. Decisions

| Topic | Decision |
|---|---|
| Network signals | **CMCD** (CTA-5004) where the player sends it natively: Shaka (query), ExoPlayer on HLS (query), AVPlayer iOS/tvOS 18+ (headers, Apple's only mode), Cast receiver via `shakaConfig` (query). Parsed with `@svta/cml-cmcd`. The session comes from our own `?sid=`, never from CMCD `sid`. |
| Device signals | `qoe` block on the heartbeat `PUT /api/playback/media/:id/state` (Live TV: `PUT /api/livetv/sessions/:sid/state`), built from `PlaybackEngine.getQoeSample()`. Optional: old clients keep working. |
| Point events | `POST /api/playback/sessions/:sid/events` (stall, error, recovery, quality switch). Also accepted shortly after the session ended, since the exit flush races the session DELETE. |
| Server signals | Per segment: how long the request waited for ffmpeg vs the segment duration (transcode speed). |
| Stall counting | Client side, engine-agnostic: engine `buffering` after the first frame, merged with a frozen-playhead detector (250 ms watch, 1 s threshold) for players that hold a starved playhead silently. Seeks, reloads, recoveries and quality switches are excluded. |
| Grouping | A `playbackId` per viewing, stable across the sids a quality switch or a recovery mints. The admin shows one item per (userId, playbackId). |
| Storage | Postgres `playback_qoe_sessions` (one row per sid, written once it reported something) + `playback_qoe_events`. One migration. Purged after `qoe_retention_days` (default 30). |
| Diagnosis | Pure `diagnose()` in `backend/src/modules/qoe/core/` (no Nest/Fliks imports, extractable). |
| Setting | App settings `qoe_enabled` (default on) and `qoe_retention_days`. Off: nothing is recorded. |
| No new infra | No Prometheus, OpenTelemetry, Sentry. Data never leaves the server. |

## 1. Wire contract

### 1.1 Heartbeat `qoe`

Counters are cumulative per sid; a counter that goes down is read as a reset.
`null` means "cannot measure"; nothing is assumed.

```ts
interface QoeSample {
  engine: 'shaka' | 'exoplayer' | 'avplayer' | 'mpv' | 'avplay' | 'webos' | 'cast';
  cmcd: boolean;                 // client claims it sends CMCD (stored as cmcdClaimed)
  playbackId?: string;           // ^[A-Za-z0-9_-]{1,64}$
  droppedFrames: number | null;
  decodedFrames: number | null;  // estimated on Apple and mpv
  bandwidthBps: number | null;
  bufferAheadS: number | null;
  variantBitrate: number | null; // bps
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  decoderName: string | null;
  hwDecoder: boolean | null;
  stallCount: number;
  stallMs: number;
  recoveryReloads: number;
}
```

### 1.2 Events

```ts
interface QoeEvent {
  type: 'stall' | 'error' | 'recovery' | 'quality_switch';
  at: number;                    // epoch ms; outside now ± 1 day → receive time
  position: number | null;
  durationMs?: number; bufferAheadS?: number | null; bandwidthBps?: number | null;
  code?: number; message?: string; category?: string;
  fromBitrate?: number; toBitrate?: number;
  variantBitrate?: number;       // stall: active rung bitrate (bps) at its start
}
// POST /api/playback/sessions/:sid/events  { events: QoeEvent[] (≤ 50), playbackId? } → 204
```

Batched with each heartbeat, flushed at once on error and with
`fetch(keepalive)` on exit. 200 events per session at most.

### 1.3 Verdict

`{ verdict: 'ok'|'network'|'device'|'server'|'error'|'unknown', confidence: 'high'|'low', reasons: string[] }`.
Reasons are `qoe.reason.*` i18n keys without params. First match wins:

1. Unrecovered fatal error → `error`.
2. Stalls (≥ 1 per 10 min or ≥ 1 % of watched time):
   - median transcode speed < 1 over the session → `server`;
   - buffer starved at stall (< 1 s) and throughput < 1.2 × bitrate → `network`;
   - starved, no throughput data → `network`, low confidence;
   - starved, throughput fine → `device`, low confidence;
   - stalls with buffer ahead → `device`.
3. Dropped frames ≥ 5 % of decoded → `device`.
4. Less than 60 s watched → `unknown` (low); otherwise `ok`.

### 1.4 Stall cause

The server classifies each stall when it is recorded and stores `cause`, `causeConfidence`,
`causeReason` (`qoe.stall.*`) and `causeEvidence` in the event `data`. First match wins; the stall
window is [at - durationMs, at]. Clients send `sentAt` with each events batch and the server shifts
`at` by its offset from it; the 5 s margin each side then only covers transport jitter (a match
that needs it is low confidence):

1. `server`, only when the buffer is unknown or < 1 s (a wait with data buffered is ffmpeg paused
   ahead of the client): a segment of the session waited for ffmpeg > 1 s in the window, or the
   median transcode speed of the segments there is < 1.
2. `network`: buffer < 1 s (event, else a fresh sample or CMCD `bl`) and throughput (event, else
   latest sample, else CMCD `mtp`) < 1.2 x the variant bitrate (event, else latest sample).
3. `device`: dropped / decoded delta >= 10 % between the samples around the stall (low confidence
   if the buffer was starved); or the buffer was >= 1 s ahead.
4. Starved with fine or unknown throughput: `network`, low (data did not arrive in time).
   Unknown buffer with throughput below the bitrate: `network`, low. Otherwise `unknown`.

A server cause also carries hints (`qoe.stall.hint_*`: software encode, burn-in subtitles, tonemap on
the CPU, 2 or more transcodes at once); they never change the decision. Live TV segment timing is
production pacing, so a live stall is `server` only when the speed is under 0.9, never on the wait.
Each stall stores a `serverLoad` snapshot (active transcodes and sessions, 1 min load average, cpus).

Each session row keeps a `pipeline` (jsonb): source and output, decoder and encoder (hardware or
software and which), tonemap path, burn-in, crop, audio transcode. It is built from the resolvers the
spawn uses at playback-info and follows a rung change on the running sid.

The session verdict's stall rule follows the cause holding most of the stalled time (the stored
`stallCauseMs`, a low-confidence stall counting half) and takes its reason from the dominant
per-stall reason (`stallReasonMs`); `unknown` winning or no classified stall falls back to the aggregate rules above.

Hints added to `reasons`, never a verdict: `software_decoder` (≥ 720p, on a
`device` verdict), `cmcd_missing` (client claims CMCD, none arrived).

## 2. Backend (`backend/src/modules/qoe/`)

- `core/`: `types`, `validate` (trust boundary: clamps ints, caps strings), `cmcd`, `aggregate` (fold samples/events/segments/CMCD, counter-reset aware, playback merge), `diagnose`.
- `QoeService`: in-memory tracker per sid (VOD live sessions and Live TV viewers), `observeSegment` on segment routes, `sessionEnded` on stop/GC, upsert every 30 s and on end, playback verdict stored for SQL filtering, daily purge.
- `cmcd` on a row is true only when the server parsed CMCD for that sid.
- Transcode sessions without a client bitrate get the served rung's nominal bitrate.
- Admin API (Read Settings, like `/api/system/streams`):
  - `/api/system/streams` items: `qoe` live summary incl. `playbackId`, `cmcd`, `cmcdClaimed`.
  - `GET /api/system/qoe/sessions?days&verdict&userId&device&limit&offset` → `{ items: QoePlayback[], total }`, one item per playback.
  - `GET /api/system/qoe/sessions/:sessionId` → the merged playback, its `sessions`, its `events`.
  - `GET /api/system/qoe/summary?days` → `{ byVerdict, byDevice }`, counted per playback.

## 3. Clients

| Client | CMCD | Frames | Bandwidth | Buffer | Decoder |
|---|---|---|---|---|---|
| Web / PWA (Shaka) | query | yes | Shaka estimate | yes | no |
| Live TV (Shaka) | query | yes | yes | yes | no |
| Android (ExoPlayer) | HLS online only | DecoderCounters | yes | yes | name + HW |
| iOS (AVPlayer) | iOS 18+ headers | dropped + estimated decoded | access log | yes | codec only |
| Apple TV (AVPlayer) | tvOS 18+ headers | dropped + estimated decoded | access log | yes | codec only |
| Desktop (mpv) | no | drops + estimated decoded | cache-speed | demuxer cache | hwdec |
| webOS (`<video>`) | no | getVideoPlaybackQuality | no (server fills bitrate) | yes | no |
| Tizen (AVPlay) | no | no | no until the unit is verified | no | no |
| Chromecast receiver | query (Shaka) | yes | yes | yes, per stall | no |

The Cast receiver sends its sample and stall episodes to the sender over
`urn:x-cast:media.fliks.app`; web, Android, iOS and desktop senders forward it
in their heartbeat and post the events.

## 4. Admin UI

- `/admin/streams`: health dot, verdict and details per live session.
- `/admin/playback-quality`: verdict breakdown (7/30 days), per-device table,
  playback list with a sessions badge, detail with per-session breakdown and
  merged timeline, JSON export, the two settings.

## 5. Later

- Suggested fixes under a verdict (disable HEVC for a device, enable HW accel).
- AVMetricEvent (iOS 18) for Apple decoded frames; Media Capabilities in the DeviceProfile; CMCD v2 event mode.
- Verify Tizen `CURRENT_BANDWIDTH` units on a real TV, then enable it.
- Extract `qoe/core` as an open-source package.
