# Tizen AVPlay HLS-fMP4 compatibility (issue #148)

Samsung Tizen Smart TVs run HLS streams through the proprietary **AVPlay**
media engine (`webapis.avplay.*`), not the browser's `<video>` element.
AVPlay's HLS-fMP4 parser is strict: it only accepts a narrow subset of
the spec — anything that diverges from Apple's reference shape either
crashes with `InvalidAccessError` / `PLAYER_ERROR_CONNECTION_FAILED` or
silently stalls (no error, no playback).

This doc captures the two production changes that make our fMP4 output
play on every Tizen firmware we've tested, plus the escape hatches we
keep around for future firmware regressions.

## 1. CMAF post-processing — `cmaf-rewrite.ts`

FFmpeg's HLS muxer hardcodes `movflags=+frag_custom+dash+delay_moov` in
`libavformat/hlsenc.c::hls_mux_init`, so `-movflags +cmaf` is silently
ignored. The on-disk segments come out as pure DASH:

```
init.mp4 :  ftyp(iso5, compat = iso5 iso6 mp41) + moov
seg.m4s  :  styp(msdh, compat = msdh cmfc) + sidx + sidx + moof + mdat
```

Apple's reference HLS-fMP4
(`devstreaming-cdn.apple.com/.../adv_dv_atmos/...`) ships:

```
init.mp4 :  ftyp(iso5, compat = isom iso5 hlsf) + moov
seg.m4s  :  (optional emsg) + moof + mdat                    -- no styp, no sidx
```

The load-bearing differences are:

| Property            | FFmpeg HLS muxer | Apple HLS-fMP4 reference | What we do |
| ------------------- | ---------------- | ------------------------ | ---------- |
| `ftyp` compat brand | `iso5 iso6 mp41` | `isom iso5 hlsf`         | Append `hlsf` |
| `styp` on segments  | present (`msdh`) | absent                   | Strip      |
| `sidx` on segments  | 2 boxes          | absent                   | Strip      |

`hlsf` ("HLS Fragmented MP4") is the marker AVPlay's parser dispatches
on — without it, the segment is treated as DASH and rejected.

`ensureCmafRewritten()` runs in-place on every served `init.mp4` /
`*.m4s` (5 call sites in `streaming.controller.ts`). The transform is
idempotent (checked via `isCmafRewritten()`) and atomic
(`writeFile(.tmp) + rename(2)`). Avg cost on a 2–3 MB segment is
sub-millisecond.

## 2. Always-separate audio/video on fMP4 — `pickAudioLayout()`

AVPlay's HLS-fMP4 parser ALSO requires the same Apple-reference
"one-track-per-init.mp4" shape — a muxed `init.mp4` carrying both
`VideoHandler` and `SoundHandler` tracks stalls playback even though no
error fires. (Tested on Tizen 6.5 / 7.0 / 8.0 firmwares.)

`pickAudioLayout()` in `streaming.controller.ts` is the single source of
truth used by:

- `buildSessionContext()` — sets `videoOnly` + `audioStreams[]` on the
  ffmpeg session context.
- `hlsMaster()` — decides whether to emit `EXT-X-MEDIA` lines.
- `playback-info` drift detection — kills the running session when the
  layout flips (e.g. when a user toggles `useTs`).

Rules:

| Audio count | Mux flavour | Layout            |
| ----------- | ----------- | ----------------- |
| 0           | any         | `inline`          |
| 1           | `fmp4`      | `var-stream-map`  |
| 1           | `ts`        | `inline`          |
| ≥ 2         | any         | `var-stream-map`  |

MPEG-TS muxes V+A natively in a single PMT and every parser handles the
muxed flavour — including Tizen — so the TS path stays muxed when
there's only one audio track. fMP4 always uses the EXT-X-MEDIA layout
once there's any audio, even for a single track.

## 3. `useTs` escape hatch

A boolean field on `DeviceProfileDto`. When true the backend emits
`-hls_segment_type mpegts` (no CMAF rewriting, no `var_stream_map` for
single-audio). Useful when:

- A new TV firmware regresses on HLS-fMP4 before we ship a backend fix.
- A power user wants to bisect a TV-side bug.

Toggled per-device by setting `localStorage['fliks.useTs'] = '1'` in
the browser/WGT console. The flag flows from
`browser-device-profile.service.ts` → `playback-info` →
`activeStreamTracker.setUseTs` and is read by `pickAudioLayout` (mux
flavour gate) and `ffmpeg-args.ts` (segment type).

Drift detection in `playback-info` notices when the flag flips mid-file
and kills the running session, so the next segment request respawns
ffmpeg with the correct mux flavour and segment layout.

## Verifying a Tizen firmware

A quick smoke-test sequence for a new TV model:

1. **Multi-audio source** (e.g. a Blu-ray rip with FR/EN tracks). Should
   play without any flag set. Confirms both the rewriter and the
   `var-stream-map` layout work end-to-end.
2. **Single-audio source**. Should also play without any flag — confirms
   the always-separate gate fires on single-audio fMP4.
3. **`fliks.useTs = '1'`** on any file. Should still play, but via the
   MPEG-TS path. Confirms the escape hatch is reachable.

When any of these regress, capture an init.mp4 + a segment from
`/tmp/transcode/stream/<mfid>-<uid>/<quality>/` on the backend and
compare the `ftyp` / first-box hex against Apple's reference:

```
hexdump -C init.mp4 | head -3
hexdump -C seg-0000.m4s | head -3
```
