# backend

NestJS API. Conventions that apply repo-wide live in the root `CLAUDE.md`.

## Streaming is the engine's

- Playback (decision, transcode, remux, HLS, segment and file serving, sessions, cache) runs in `github.com/fliks-app/engine`. Video work goes there, not here.
- Nest keeps the control plane only: `POST /api/stream/:id/playback-info` (ACL, burn-in, scan, markers, pre-roll, EDL around `POST /v1/sessions`), `DELETE sessions/:sid`, `info/*`, `:id/edl`, presence (`LiveSessionRegistry`, fed by the engine's events) and the resolver the engine calls (`/engine/resolve`).
- Without an engine, playback-info answers 503. Hardware state (`HostHardwareService`) comes from `/v1/capabilities`.
- After a protocol change, regenerate the types with `scripts/bump-engine.sh` (`--local ../fliks-engine` for a local checkout); never edit `src/modules/engine/schema.d.ts`.
- Still spawned by Node until the engine's jobs (M5) and live runtime (M6) land: sprites, the keyframe scan, the ffprobe fallback when the engine is down, burn-in subtitle extraction, live TV, and the `subtitles/` and `markers/` tools.
