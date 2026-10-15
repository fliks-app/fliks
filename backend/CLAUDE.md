# backend

NestJS API. Conventions that apply repo-wide live in the root `CLAUDE.md`.

## Streaming is the engine's

- Playback (decision, transcode, remux, HLS, segment and file serving, sessions, cache) runs in `github.com/fliks-app/engine`. Video work goes there, not here.
- Nest keeps the control plane only: `POST /api/stream/:id/playback-info` (ACL, burn-in, scan, markers, pre-roll, EDL around `POST /v1/sessions`), `DELETE sessions/:sid`, `info/*`, `:id/edl`, presence (`LiveSessionRegistry`, fed by the engine's events) and the resolver the engine calls (`/engine/resolve`).
- Without an engine, playback-info answers 503. Hardware state (`HostHardwareService`) comes from `/v1/capabilities`.
- After a protocol change, regenerate the types with `scripts/bump-engine.sh` (`--local ../fliks-engine` for a local checkout); never edit `src/modules/engine/schema.d.ts`.
- Background media work is the engine's too: probe (`FfprobeService` is a thin client of `/v1/probe`, no local fallback: engine down means an import fails and retries later) and the `Sprite`, `Scan`, `Fingerprint` and `SubtitleExtract` jobs through `EngineService.runJob`, settled by `BgJobDone` on the events stream. Priorities: user-triggered `high`, bulk `normal`, post-import `low`.
- Live TV is the engine's too (`POST /v1/live`): upstream connections, probe, remux/transcode, HLS, DVR window, failover and the data plane (`/api/livetv/sessions/:sid/*`). Nest keeps the catalog, EPG, sources, access and capacity policy (`LiveTvSessionService`: capacity holds per `capacityToken`, freed by `LiveReleased`), the `/engine/resolve` check with `purpose: live` and the heartbeat. Node spawns nothing for live TV.
- Node still spawns media tools only for OCR, subtitle sync and translation (M8) and non-media work (backups, plugins). Never a probe, transcode, remux, HLS run, sprite, scan, fingerprint or live TV.
