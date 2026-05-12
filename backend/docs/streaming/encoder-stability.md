# Long-running QSV transcodes + seek-resume seam

This note explains the encoder configuration and the seek-resume FFmpeg
args used by `backend/src/modules/streaming/transcoding/ffmpeg-args.ts`,
plus the two bugs they fix. Keep it next to the source — when you
question why a flag is there, the answer is here.

## Background

The streaming backend transcodes media into HLS fmp4 segments via
FFmpeg with VAAPI decode + h264_qsv encode on Intel iGPUs. A single
FFmpeg process serves the whole session: cold-spawned on the first
segment request, killed only on seek-resume (when the player requests a
segment ahead of the encoder's frontier by more than
`SEEK_WAIT_THRESHOLD`).

Two distinct issues bite in this setup. The first concerns the encoder
itself drifting over long runs; the second concerns the timestamp
wiring at seek-resume. They each have their own root cause and fix.

## Issue 1 — 45 s GOPs after ~17 min of continuous encoding

**Symptom.** The HLS muxer pools samples until the next IDR, producing
one giant segment that overruns its `EXTINF` slot. The player stalls or
drops the stream.

**Root cause.** Despite the "BRC drift" label this isn't a bitrate-
controller issue. When `-adaptive_i 1` is on and a scene-cut IDR has
been emitted "close enough" to a `force_key_frames` instant, Intel
Media SDK refuses to promote the forced instant to a real IDR and emits
a plain I-frame instead (Intel-Media-SDK#2776, jellyfin-ffmpeg#413).
The HLS muxer waits for an IDR before cutting a new segment, so it
keeps pooling samples until one finally shows up — that's where the
45 s GOP comes from. The ~17 min cadence is just the phase between
`-g`, the SDK's internal IDR cycle and the adaptive-I heuristic finally
lining up against our `force_key_frames` ticks.

**Fix — encoder configuration.**

```
-c:v h264_qsv
-forced_idr 1        # every force_key_frames tick lands as a real IDR
-adaptive_i 0        # scene-cut placement off (it fights forced IDRs)
-bf 0                # no B-frames
-b_strategy 0        # closed GOP, deterministic IDR placement
-mbbrc 1
-b:v X -maxrate X+1
-bufsize X           # tight VBV (1× target); a larger buffer lets the
                     # BRC defer big I-frames on dense scenes
-g <fps×SEG> -keyint_min <fps×SEG>
-force_key_frames expr:gte(t, seekSeconds + n_forced*SEG)
```

`-forced_idr 1` is the load-bearing flag. `-adaptive_i 0` is needed
alongside it because the adaptive-I heuristic is exactly what races
with forced keyframes. `-bf 0` removes B-frame reordering at segment
edges so the HLS muxer cuts cleanly on each forced IDR. Tight VBV
(`bufsize = bitrate`) shrinks the BRC's "save up bits" window, which
is the secondary factor that lets the encoder defer big I-frames on
dense scenes.

## Issue 2 — A/V seam after a user seek

**Symptom.** After seeking to `T`, video shows content from a few
seconds before `T` while audio is correctly anchored at `T`.

**Root cause.** `-ss T -i input` with VAAPI decode + `accurate_seek`
(default) doesn't reliably drop frames before `T` on hardware-decoded
surfaces. The decoder emits frames from the source keyframe `≤ T`
(could be 5–10 s before `T`), and the encoder's mandatory first IDR
lands on that earliest frame instead of on `T`. Video `tfdt` ends up
several seconds behind audio `tfdt` (audio still snaps to the
audio-frame boundary `≤ T`, drift bounded to ±21–40 ms).

**Fix — seek-resume FFmpeg args.** For a resume at content time `T`
(`startSegment > 0`):

```
-ss T                       # before -i — fast demuxer seek to keyframe ≤ T
-i input.mkv
-copyts                     # propagate source PTS end-to-end
-muxdelay 0 -muxpreload 0   # no priming edit-list on the first IDR
-ss T                       # after -i — drop decoded frames < T before encoder
-force_key_frames "expr:gte(t, T + n_forced*SEG)"
```

The double `-ss` is intentional and not redundant:

- The first `-ss T` is the demuxer-side seek (jumps quickly to the
  keyframe `≤ T`).
- `-copyts` keeps source PTS on every decoded frame all the way to the
  muxer, so `tfdt` on the first written segment is `T × timescale`.
- The second `-ss T` is the output-seek: with `-copyts` it operates in
  source-time and drops decoded frames before they reach the encoder,
  including the frames between the source keyframe and `T` that the
  HW-decoder path doesn't trim on its own.
- The encoder receives only frames with PTS ≥ T; its forced first IDR
  lands at `T`. Video `tfdt = T`, audio `tfdt ≈ T` (audio is packet-
  snapped at the demuxer; the drift is bounded to ±21 ms for AAC,
  ±32 ms for AC-3, ±40 ms for DTS — imperceptible).
- `-force_key_frames` anchors at `seekSeconds` instead of `0`: with
  `-copyts` the encoder's `t` variable is in source time, so the
  expression has to acknowledge that.

This works for `-c:a copy` and re-encode audio alike — `-copyts` is
codec-agnostic. `-af atrim` would have been a sample-accurate audio
trim but is incompatible with `-c:a copy` ("Filtering and streamcopy
cannot be used together"); the demuxer-snap drift on copy audio is
small enough to not need active correction.

## Things to NOT do

- Pair `-avoid_negative_ts make_zero` with `-output_ts_offset T`. They
  cancel each other on the fmp4 muxer (the offset is applied, then
  `make_zero` zeroes every timestamp), and the HLS muxer pools samples
  until the next encoder-natural keyframe.
- Drop `-forced_idr 1`. HLS needs a guaranteed IDR at every segment
  boundary; without `forced_idr` the SDK will skip some of them.
- Turn `-adaptive_i` back on. The scene-cut placement races with the
  forced-IDR cadence and brings the 45 s GOP back.
- Add `-extbrc 1` or `-look_ahead 1`. Both have known long-run
  bitrate-control regressions (Intel-Media-SDK#1511) and aren't needed
  for this use case.

## Fallback ladder if the encoder still drifts

If a future media file / driver combination exhibits drift past the
17-min mark despite the config above, try in order:

1. **CBR**: set `-minrate = -b:v = -maxrate`, keep `-bufsize 2*bitrate`.
   Removes the VBR envelope entirely.
2. **Add `-max_frame_size <bytes>`**. Caps the worst-case I-frame so
   the BRC has slack for the next forced IDR.
3. **ICQ**: `-global_quality 23 -look_ahead 0`. No bitrate accumulator,
   IDR placement becomes deterministic at the cost of variable bitrate.
4. **CQP**: `-q 23`. No BRC state at all — diagnostic-only; if CQP also
   drifts, the bug is in the driver, not the encoder logic.
5. **Switch to `h264_vaapi`**. Same hardware path, different BRC
   implementation; not known to exhibit this drift.

## References

- Intel-Media-SDK#2776 — `forced_idr` bug in `h264_qsv`
- jellyfin-ffmpeg#413 — QSV produces unplayable HLS segments
- intel/media-driver#1576 — QSV produces files with one I-frame
- FFmpeg-devel "respect user's setting for keyframes" patch
- intel/media-delivery `quality.rst` — HLS streaming recommendations
- Jellyfin `MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs`
  (one-long-FFmpeg pattern + GOP-based keyframe forcing)
