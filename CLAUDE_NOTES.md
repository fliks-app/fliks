# Branch notes — `feat/hdr-passthrough-hevc`

Pickup point for resuming work on another machine.

## Problem

iOS AVPlayer fails with `CoreMediaErrorDomain -12927` on HDR content. Symptom: empty `errorLog()`, meaning AVPlayer rejects at variant selection before any segment fetch. Android / web tolerate the same backend output silently (with wrong color rendering), iOS strict-validates.

Root cause confirmed via Safari Web Inspector dump of `master.m3u8`:
- Backend was serving `CODECS="avc1.640034"` (H.264) for a Transcode path on an HDR HEVC source.
- `stream-builder` set `needsTonemapping=false` (treated `canPassThroughHdr` as session-wide) → FFmpeg encoded HDR pixels to H.264 8-bit **without** the tonemap filter.
- Resulting H.264 carried BT.2020/PQ tags in the SPS VUI but had SDR-range pixels. iOS rejected the codec/range mismatch.

## What's done on this branch

Latest commit: `0499b97 feat(streaming): HEVC HDR ladder for HDR sources + HDR-capable clients`.

PR: <https://github.com/fliks-app/fliks/pull/133>

Architecture:
- HEVC HDR ladder (`-hdr` suffixed profile names) in `profiles.ts`. Bitrates ~70% of H.264 equivalents (HEVC efficiency).
- `hevc_qsv` Main10 encoder pipeline in `ffmpeg-args.ts`: VAAPI decode → `scale_vaapi` keeping p010le → hwmap qsv → `hevc_qsv -profile:v main10` with BT.2020/PQ color flags + `-tag:v hvc1`.
- `master.m3u8` emits full HEVC HDR ladder when source = HEVC HDR + client claims HDR. Top rung = remux (`-c:v copy`) at source resolution. Lower rungs = `hevc_qsv` transcodes. Each rung carries `VIDEO-RANGE=PQ|HLG` + `hvc1.2.4.L*.B0` CODECS.
- `stream-builder` gates on `useHdrLadder = isSourceHdr && clientSupportsHdr && sourceVideoCodec === 'hevc' && !FLIKS_DISABLE_HEVC_HDR`. Records the decision in `ActiveStreamTracker.setHdrLadder` for `master.m3u8` to read at request time (decoupled from `?remux=1`).
- H.264 tonemap path now forces `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv` to override h264_qsv's habit of carrying source HDR tags through to the SPS.
- Remux path: `-tag:v hvc1` + `-bsf:v hevc_mp4toannexb` + `-max_muxing_queue_size 2048` when source is HEVC (HLS spec conformance).
- iOS plugin: removed `preferredMaximumResolution` / `preferredPeakBitRate` caps that silently rejected variants exceeding screen native size on single-variant manifests. Diagnostic dumping of manifest + errorLog left in for now (clean up before merge if PR is greenlit).
- `FLIKS_DISABLE_HEVC_HDR=1` env escape hatch → falls back to H.264 SDR tonemap ladder on every rung.

## How to test

1. `docker pull ghcr.io/fliks-app/fliks:hdr-test` (rebuilds triggered automatically on every push to the branch via `docker-publish.yml workflow_dispatch tag=hdr-test`).
2. Re-deploy backend with the new image.
3. iOS: rebuild Xcode (`cap sync ios` first if Swift was touched), install on device, replay an HDR HEVC source with HDR enabled in playback settings.
4. Expected: master.m3u8 shows HEVC HDR ladder with `VIDEO-RANGE=PQ` + `hvc1.*` CODECS. AVPlayer plays HDR natively. Quality picker offers `1080p-hdr`, `720p-hdr`, etc.
5. Safari Web Inspector → Develop → \[iPhone\] → app webview → Console. Look for `[NativePlayer] manifest:` then `[NativePlayer] load`. Any error appears as `[NativePlayer] error -12927 ...`.

## What's not done / open questions

- **No `dvh1` codec string for Dolby Vision sources** — only HDR10 / HLG handled. DV would need a separate codec string (`dvh1.05.*` etc.) + `VIDEO-RANGE=PQ` and `DOLBY-VISION` tag. Out of scope for this PR.
- **No HEVC HDR support on VAAPI / NVENC backends** — `hevc_qsv` is wired but the `vaapi` and `nvenc` switch branches still fall through to their H.264 cases for `-hdr` profiles. Add `hevc_vaapi` and `hevc_nvenc` paths if other deployments need them.
- **Multi-audio HDR pass-through** — emits EXT-X-MEDIA but the remux session muxes a single audio track. Switching audio mid-stream requires backend reload. Could split into video-only remux + audio-only renditions like the H.264 path does, but adds complexity.
- **iOS manifest dump + load tracing in `NativePlayerPlugin.swift`** are diagnostic. Strip them before merging to main.
- **Diagnostic Console.app evidence still missing** — every fix in this branch was driven by the one manifest dump the user captured. If `-12927` returns, the next step is a fresh manifest dump + errorLog content + ffprobe of `/api/stream/<id>/remux/init.mp4` (the user has the `https://fliks.delestre.me` backend URL handy).

## Files modified

```
backend/src/modules/streaming/active-stream-tracker.service.ts
backend/src/modules/streaming/stream-builder.service.ts
backend/src/modules/streaming/streaming.controller.ts
backend/src/modules/streaming/transcoding/ffmpeg-args.ts
backend/src/modules/streaming/transcoding/index.ts
backend/src/modules/streaming/transcoding/master-playlist.ts
backend/src/modules/streaming/transcoding/profiles.ts
backend/src/modules/streaming/transcoding/transcoding.service.ts
backend/src/modules/streaming/transcoding/types.ts
client/ios/App/App/NativePlayerPlugin.swift
client/ios/App/App/HdrPlugin.swift      (reverted to original AVPlayer.eligibleForHDRPlayback)
```

Earlier PR `#132` (already merged) covered the spinner / ABR / per-rung CODECS work — referenced for context.
