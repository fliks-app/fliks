# Playback QoE telemetry: why does this client stutter?

Implementation-ready design. Every client reports playback quality; the server
diagnoses each session (network, device, server, error) and the admin sees it
live in `/admin/streams` and historically in a new *Playback quality* page.

## 0. Decisions

| Topic | Decision |
|---|---|
| Network signals | **CMCD** (CTA-5004) on segment requests where the player supports it natively: Shaka (query mode), ExoPlayer (query mode), AVPlayer iOS/tvOS 18+ (headers only, the only mode Apple offers), Cast via `shakaConfig` (query). Parsed server-side with `@svta/cml-cmcd` (`fromCmcdQuery` / `fromCmcdHeaders`). The session is resolved from our own `?sid=`, never from CMCD `sid`. |
| Device signals | `qoe` block on the existing heartbeat `PUT /api/playback/media/:id/state`, built from `PlaybackEngine.getQoeSample()`. Optional, old clients keep working. |
| Point events | `POST /api/playback/sessions/:sessionId/events` (stall, error, recovery reload, quality switch). Needed because a fatal error ends the heartbeat. Capped at 200 events per session server-side. |
| Server signals | Per-segment: time the request waited for ffmpeg to produce it vs segment duration (transcode speed), and bytes / send time (fallback throughput for non-CMCD clients). |
| Stall counting | In `player.ts`, engine-agnostic: a `buffering` state after first frame that is not a seek/load. Engines do not count stalls. |
| Storage | Postgres: `playback_qoe_sessions` (one row per session, upserted) + `playback_qoe_events`. Purged after `qoeRetentionDays` (default 30). |
| Diagnosis | One pure function `diagnose()` in `backend/src/modules/qoe/core/`, no Nest/Fliks imports (future open-source extraction). |
| Setting | App setting `qoeEnabled` (default true). Off: heartbeat `qoe` and events are ignored, nothing stored. |
| No new infra | No Prometheus, OpenTelemetry, Sentry. Data never leaves the server. |

## 1. Wire contract

### 1.1 `QoeSample` (client → heartbeat `qoe`)

Counters are **cumulative since the engine's last `load()`**; the server
treats a counter that goes down as a reset. `null` = this engine cannot measure it.

```ts
interface QoeSample {
  engine: 'shaka' | 'exoplayer' | 'avplayer' | 'mpv' | 'avplay' | 'webos' | 'cast';
  cmcd: boolean;                 // this playback sends CMCD on segment requests
  droppedFrames: number | null;
  decodedFrames: number | null;
  bandwidthBps: number | null;   // player's own throughput estimate
  bufferAheadS: number | null;   // seconds buffered ahead of the playhead
  variantBitrate: number | null; // bps of the variant being played
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  decoderName: string | null;    // e.g. c2.qti.hevc.decoder, hevc_vaapi
  hwDecoder: boolean | null;
  // filled by player.ts, not the engine:
  stallCount: number;
  stallMs: number;
  recoveryReloads: number;
}
```

### 1.2 Events

```ts
type QoeEventType = 'stall' | 'error' | 'recovery' | 'quality_switch';
interface QoeEvent {
  type: QoeEventType;
  at: number;                 // epoch ms, client clock
  position: number | null;
  durationMs?: number;        // stall
  bufferAheadS?: number | null;
  bandwidthBps?: number | null;
  code?: number; message?: string; category?: string;   // error (classifyPlaybackError)
  fromBitrate?: number; toBitrate?: number;             // quality_switch
}
// POST /api/playback/sessions/:sessionId/events  { events: QoeEvent[] }  → 204
```

Sent batched (flush every heartbeat, immediately on `error`, on player exit
with `fetch(..., { keepalive: true })`). Same auth as the heartbeat
(`SessionTokenGuard`); a session owned by another user is rejected.

### 1.3 Verdict

```ts
type QoeVerdict = 'ok' | 'network' | 'device' | 'server' | 'error' | 'unknown';
interface QoeDiagnosis {
  verdict: QoeVerdict;
  confidence: 'high' | 'low';
  reasons: string[];          // i18n keys + params, rendered by the admin UI
}
```

Rules (first match wins, thresholds as named constants):

1. Fatal error with no successful recovery → `error`.
2. Stalls (≥ 1 stall/10 min or stall ratio ≥ 1 %):
   - server produced segments slower than real time (median speed < 1.0 over the stall window) → `server`;
   - else buffer starved (`bl`≈0 / `bufferAheadS` < 1 s at stall) and throughput < 1.2 × variant bitrate → `network`;
   - else buffer starved with no throughput data → `network`, low confidence;
   - else (stalls with buffer ahead) → `device`.
3. No stall but dropped frames ≥ 5 % of decoded, or `hwDecoder === false` on ≥ 1080p → `device`.
4. Otherwise `ok`. Too little data (< 60 s watched) → `unknown`.

Confidence is `high` when the deciding signal came from CMCD or the engine,
`low` when inferred from server-side throughput only.

## 2. Backend (`backend/src/modules/qoe/`)

- `core/` (pure, extractable): `types.ts`, `diagnose.ts` (+ spec), `cmcd.ts` (read CMCD from a request's query/headers into a flat `{bl, mtp, br, tb, bs, su}`), `aggregate.ts` (fold samples/events/segment metrics into a session summary, counter-reset aware).
- `QoeService`: in-memory tracker per live sessionId; `recordSample`, `recordEvents`, `recordSegment`, `recordCmcd`; upserts `playback_qoe_sessions` at most every 30 s and on session end (hook the LiveSession GC / `DELETE sessions/:id`); purge job in the scheduler.
- Hooks in `streaming.controller.ts` segment routes (video + audio): CMCD read, produce-wait timing, send timing (`res.on('finish')`).
- Heartbeat: `playback.controller.ts` passes `body.qoe` to `QoeService`.
- Admin API (same permission as `/api/system/streams`):
  - `/api/system/streams` items gain `qoe: { verdict, confidence, reasons, stallCount, stallMs, droppedPct, bandwidthBps, variantBitrate, bufferAheadS, hwDecoder, decoderName, transcodeSpeed, engine, cmcd } | null`.
  - `GET /api/system/qoe/sessions?days&verdict&userId&device&limit&offset`
  - `GET /api/system/qoe/sessions/:sessionId` (row + events)
  - `GET /api/system/qoe/summary?days=7` → `{ byVerdict: Record<QoeVerdict, number>, byDevice: { device, engine, sessions, stallSessions, avgDroppedPct, hwDecoderPct, topVerdict }[] }`
- Migration: two tables, TypeORM migration in `backend/src/migrations/`.

## 3. Clients

`PlaybackEngine.getQoeSample(): Promise<Omit<QoeSample, 'stallCount'|'stallMs'|'recoveryReloads'>>`.

| Client | Engine file | CMCD | Sample source |
|---|---|---|---|
| Web / PWA | `shaka-engine.ts` | `cmcd: { enabled: true, useHeaders: false }` | `player.getStats()` (decoded/dropped frames, estimatedBandwidth), `getVariantTracks()` active, `bufferedAhead` |
| Live TV | `live-player.ts` | same | same (counts as `shaka`) |
| Android | `native-engine.ts` + `NativePlayerPlugin.java` | `CmcdConfiguration`, `MODE_QUERY_PARAMETER` | `AnalyticsListener`: `onDroppedVideoFrames`, `onBandwidthEstimate`, `onVideoDecoderInitialized` (+ `MediaCodecInfo.isHardwareAccelerated`), `DecoderCounters`; new plugin method `getQoe()` |
| iOS | `native-engine.ts` + `NativePlayerPlugin.swift` | `resourceLoader.sendsCommonMediaClientDataAsHTTPHeaders = true` under `#available(iOS 18)` | `currentItem.accessLog()` last event (`numberOfDroppedVideoFrames`, `observedBitrate`, `indicatedBitrate`), `errorLog()` → error events |
| Apple TV | `appletv/…/PlaybackService.swift`, `PlayerView.swift` | same, `#available(tvOS 18)` | same; adds `qoe` to its own heartbeat and posts events |
| Desktop | `desktop-engine.ts` + mpv bridge (3 backends) | none | mpv: `frame-drop-count`, `decoder-frame-drop-count`, `estimated-frame-number`, `hwdec-current`, `cache-speed`, `demuxer-cache-duration`, `video-bitrate`, `video-codec` |
| webOS | `webos-engine.ts` | none | `getVideoPlaybackQuality()` (webOS 22+, prefixed fallback), buffered ahead |
| Tizen | `tizen-engine.ts` | none | `getStreamingProperty('CURRENT_BANDWIDTH')`, `getCurrentStreamInfo()` (codec, bitrate); frames `null` |
| Chromecast | `cast-receiver/receiver.js` | `useShakaForHls` + `shakaConfig.cmcd` | `PlayerManager.getStats()`; receiver posts heartbeat `qoe` itself if it has the sid/token, else via the sender |

`player.ts`: stall/recovery counting, merges the engine sample into the
heartbeat, sends `state: 'buffering'` (today it never does), owns a small
`QoeReporter` for events.

## 4. Admin UI

- `/admin/streams`: per session a health dot (green ok, orange low-confidence or minor, red verdict ≠ ok), the verdict label, and a details popover (throughput vs bitrate, buffer, dropped %, decoder, transcode speed, engine, CMCD yes/no).
- New `/admin/playback-quality` (settings section next to Streams): verdict breakdown over 7/30 days, per-device table (the "is this TV too weak" view), filterable session list, session detail with event timeline, JSON export.
- All strings via ngx-translate (en + fr at least, follow existing locale files).

## 5. Later (not in this work)

- Suggested fixes under a verdict (disable HEVC for a device, enable HW accel).
- CMCD v2 event mode, Media Capabilities `decodingInfo()` in the DeviceProfile, AVMetricEvent (iOS 18).
- Extracting `qoe/core` + CMCD shims as an open-source package.
