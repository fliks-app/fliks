# backend

NestJS API. Conventions that apply repo-wide live in the root `CLAUDE.md`.

- A route ported to `server/` is deleted here; see `server/docs/bridge.md`.

## Streaming is the engine's

- Playback (decision, transcode, remux, HLS, segment and file serving, sessions, cache) runs in `github.com/fliks-app/engine`. Video work goes there, not here.
- Nest keeps the control plane only: `POST /api/stream/:id/playback-info` (ACL, burn-in, scan, markers, pre-roll, EDL around `POST /v1/sessions`), `DELETE sessions/:sid`, `info/*`, `:id/edl`, presence (`LiveSessionRegistry`, fed by the engine's events).
- Without an engine, playback-info answers 503. Hardware state (`HostHardwareService`) comes from `/v1/capabilities`.
- After a protocol change, regenerate the types with `scripts/bump-engine.sh` (`--local ../fliks-engine` for a local checkout); never edit `src/modules/engine/schema.d.ts`.
- Background media work is the engine's too: probe (`FfprobeService` is a thin client of `/v1/probe`, no local fallback: engine down means an import fails and retries later) and the `Sprite`, `Scan`, `Fingerprint` and `SubtitleExtract` jobs through `EngineService.runJob`, settled by `BgJobDone` on the events stream. Priorities: user-triggered `high`, bulk `normal`, post-import `low`.
- Live TV is the engine's data plane (`POST /v1/live`) and `fliks-server`'s control plane (catalog, EPG, sources, access, capacity, sessions, resolver `live`); Nest keeps only the entities until S9.
- Node spawns no media tools: OCR, subtitle sync and subtitle-to-SRT are engine jobs through `EngineService.runJob`; translation HTTP calls stay in Nest; backups and plugins still run here.
