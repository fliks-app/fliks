import {
  getHdrLadderForDevice,
  getLadderForDevice,
  parseBitrateToBps,
  profileFitsSource,
  profileResolution,
} from './profiles';
import type {
  AudioStreamMeta,
  DeviceType,
  SubtitleRenditionMeta,
  TranscodeProfile,
} from './types';
import type { CodecVariant } from './codec/types';
import {
  audioCodecString,
  audioRenditionChannels,
  av1CodecString,
  h264CodecString,
  hevcMain10CodecString,
  hevcMainCodecString,
} from './codec/codec-strings';

/** Format frame rate for the HLS `FRAME-RATE` attribute. Apple's spec
 *  says "decimal-floating-point describing the maximum frame rate …
 *  rounded to three decimal places". Whole numbers stay integer to
 *  match Apple's reference manifests (e.g. `60`, not `60.000`). */
function formatFrameRate(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/** Apply the `onlyQuality` URL pin to a ladder. Used identically by
 *  the SDR and HDR branches: when the player has a saved quality
 *  preference (or an explicit dropdown pick), the master playlist
 *  emits a single-variant ladder so ExoPlayer's HLS source can't
 *  pre-load other variants — each unfocused variant playlist or
 *  init.mp4 fetch triggers a ffmpeg kill+respawn on the backend
 *  when the requested quality doesn't match the active session.
 *
 *  - `remux` / `original` collapse to the single top profile that fits
 *    the source resolution (no upscale), in both the SDR and HDR
 *    ladders — one variant so AVPlayer / ExoPlayer have no other rung
 *    to ABR-switch to and stay locked at the source quality. Fitting is
 *    delegated to {@link profileFitsSource} (bucket on both axes) so
 *    anamorphic or scope crops (e.g. 1918×872) keep their 1080p top
 *    rung — a strict `maxWidth <= sourceWidth` check sat one or two
 *    pixels short and dropped the user back to 720p.
 *  - When `hdrSuffix` is true, an input `1080p` is matched against
 *    `1080p-hdr` (HDR ladder rungs carry the suffix); already
 *    `*-hdr` inputs pass through unchanged.
 *  - Falls back to the full ladder when the pin doesn't match any
 *    rung (legacy URLs / typos). */
function applyQualityPin(
  ladder: TranscodeProfile[],
  onlyQuality: string | undefined,
  sourceWidth: number,
  sourceHeight: number,
  hdrSuffix = false,
): TranscodeProfile[] {
  if (!onlyQuality) return ladder;
  if (onlyQuality === 'remux' || onlyQuality === 'original') {
    const top =
      ladder.find((p) => profileFitsSource(p, sourceWidth, sourceHeight)) ??
      ladder[0];
    return [top];
  }
  const wanted =
    hdrSuffix && !onlyQuality.endsWith('-hdr')
      ? `${onlyQuality}-hdr`
      : onlyQuality;
  const picked = ladder.find((p) => p.name === wanted);
  return picked ? [picked] : ladder;
}

/**
 * Get available quality profiles for a given source resolution + device class.
 */
export function getAvailableProfiles(
  sourceWidth: number,
  sourceHeight: number,
  deviceType: DeviceType = 'desktop',
): TranscodeProfile[] {
  return getLadderForDevice(deviceType).filter((p) =>
    profileFitsSource(p, sourceWidth, sourceHeight),
  );
}

/**
 * Generate the HLS master playlist listing available qualities.
 */
export function generateMasterPlaylist(
  mediaFileId: number,
  sourceWidth: number,
  sourceHeight: number,
  tokenParam: string,
  includeRemux = false,
  sourceBitrate?: number,
  audioStreams?: AudioStreamMeta[],
  onlyQuality?: string,
  defaultAudioIndex = 0,
  deviceType: DeviceType = 'desktop',
  /** Output audio codec actually emitted by ffmpeg. The CODECS attribute
   *  must match or the receiver rejects the segment at MSE chunk-demuxer
   *  append. Recognised values: `'aac'` (AAC-LC), `'ac3'` (Dolby Digital),
   *  `'eac3'` (Dolby Digital Plus). Defaults to AAC for legacy callers. */
  outputAudioCodec: string = 'aac',
  /** When set, the master advertises a single HEVC HDR variant pointing at
   *  the `remux/index.m3u8` path instead of the H.264 transcode ladder.
   *  The remux session does `-c:v copy` so the HDR metadata (BT.2020/PQ
   *  or HLG transfer) reaches the player intact. iOS AVPlayer / ExoPlayer
   *  use the `VIDEO-RANGE` attribute + `hvc1.*` codec string to dispatch
   *  to the HDR rendering path. */
  hdrPassThrough?: {
    hdrFormat: 'HDR10' | 'HLG';
    videoBitRateBps?: number;
    audioBitRateBps?: number;
  },
  /** True when the backend can actually emit HEVC Main10 segments — only
   *  the QSV path has `hevc_qsv Main10` wired (ffmpeg-args.ts). Other
   *  hwAccels (VAAPI, NVENC, VideoToolbox, CPU) fall through to libx264
   *  and produce H.264 segments that contradict the master's `hvc1.*`
   *  CODECS string, which trips a Media3 fallback-options crash on
   *  ExoPlayer. When false, only the remux pass-through rung is emitted
   *  — that path is `-c:v copy` and works regardless of hwAccel. */
  canEncodeHevcHdr = false,
  /** SDR-ladder output codec, picked by the codec selector. When the
   *  selector promoted HEVC (source codec match, or efficiency
   *  ranking on HEVC-capable clients), every SDR rung emits a
   *  `hvc1.*` CODECS string instead of `avc1.*` so MSE doesn't reject
   *  the appended segments. Absent for legacy callers that haven't
   *  threaded the variant through — falls back to H.264 codec strings. */
  sdrVariant?: CodecVariant,
  /** Source frame rate in fps (e.g. 23.976, 24, 29.97). Emitted as the
   *  HLS `FRAME-RATE` attribute on every `#EXT-X-STREAM-INF` and fed
   *  into the codec-string level computation. REQUIRED on HDR variants:
   *  Apple's HLS parser rejects PQ/HLG rungs missing `FRAME-RATE` with
   *  `HDR alternate is missing FRAME-RATE` (CoreMedia -12642), and when
   *  every HDR variant is filtered out AVPlayer surfaces the empty
   *  playable set as `NSURLErrorUnsupportedURL -1002`. Defaults to 24
   *  so legacy callers without source info still produce a valid
   *  manifest. */
  sourceFrameRate = 24,
  /** Text subtitle tracks to advertise as an HLS `SUBTITLES` rendition
   *  group. When non-empty, a `#EXT-X-MEDIA:TYPE=SUBTITLES` line is emitted
   *  per track and every `#EXT-X-STREAM-INF` gains `SUBTITLES="subs"`, so a
   *  native HLS player (AVPlayer, ExoPlayer, AVPlay, webOS) renders cues
   *  inside its own pipeline — visible in PiP / AirPlay / lock-screen.
   *  Empty / undefined keeps the manifest subtitle-free (web + older
   *  clients keep fetching sidecar VTT). The renditions are decoupled from
   *  the video transcode: each URI points at a tiny media playlist wrapping
   *  the WebVTT the subtitle service already extracts, so the HEVC
   *  `var_stream_map` is untouched (no decoder-buffer regression). */
  subtitleRenditions?: SubtitleRenditionMeta[],
): string {
  // The "multi-audio" flag is really an "EXT-X-MEDIA layout" toggle —
  // the caller decided whether to split audio into renditions. Single-
  // audio sources can opt-in (Tizen fMP4 needs it; see issue #148), so
  // we honour any non-empty `audioStreams` list rather than gating on
  // `length > 1`. Callers that want the muxed layout pass `undefined`.
  const multiAudio = audioStreams && audioStreams.length > 0;
  // Audio-less source: ffmpeg emits `-an` so the segments truly carry no
  // audio. The master MUST NOT advertise an audio codec in CODECS — Shaka
  // and ExoPlayer reject the variant when the manifest declares a track
  // the segments don't contain (iOS AVPlayer is permissive enough to play
  // it anyway, which is why this only surfaces on Shaka / Exo).
  const noAudio = audioStreams != null && audioStreams.length === 0;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  const audioCodec = audioCodecString(outputAudioCodec);
  const codecsTail = noAudio || !audioCodec ? '' : `,${audioCodec}`;

  const frameRateAttr = `,FRAME-RATE=${formatFrameRate(sourceFrameRate)}`;

  // Subtitle renditions: one shared `subs` group, referenced by every
  // variant via `SUBTITLES="subs"`. Emitted in both the SDR and HDR
  // branches so the group is present whichever ladder the master uses.
  const hasSubs = subtitleRenditions != null && subtitleRenditions.length > 0;
  const subsAttr = hasSubs ? ',SUBTITLES="subs"' : '';
  const pushSubtitleMedia = (out: string[]): void => {
    if (!hasSubs) return;
    // `name` is a human label (track title / language). Two tracks can resolve
    // to the same string, so uniquify with an increment (#2 on collision) — a
    // native player (AirPlay, lock-screen) dedupes identical NAMEs into one
    // selectable option otherwise.
    const names = buildUniqueAudioNames(
      subtitleRenditions.map((s) => ({ title: s.name, language: s.language })),
    );
    subtitleRenditions.forEach((s, i) => {
      const lang = s.language || 'und';
      const path =
        s.kind === 'embedded'
          ? `subtitles/embedded/${s.key}`
          : `subtitles/${s.key}`;
      out.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${names[i]}",LANGUAGE="${lang}",DEFAULT=NO,AUTOSELECT=NO,FORCED=${s.forced ? 'YES' : 'NO'},URI="/api/stream/${mediaFileId}/${path}/index.m3u8${tokenParam}"`,
      );
    });
  };

  // HDR pass-through path — emitted when the source is HEVC HDR and
  // the client claims HDR support. Outputs a full HEVC HDR ladder
  // (one remux rung at source resolution + HEVC HDR transcode rungs
  // below) so the user can switch resolution while keeping HDR
  // signaling (BT.2020/PQ or HLG). The H.264 SDR ladder is omitted in
  // this branch — mixing SDR and HDR rungs in one master playlist
  // confuses AVPlayer's ABR and triggers display-mode flips. Clients
  // that want SDR explicitly disable HDR client-side (which flips
  // `clientSupportsHdr` to false and re-routes to the SDR ladder).
  if (hdrPassThrough) {
    const range = hdrPassThrough.hdrFormat === 'HLG' ? 'HLG' : 'PQ';

    // Multi-audio: each HEVC HDR variant references the shared audio
    // group via AUDIO="audio". Audio is served from /audio/<i>/ as
    // standalone AAC renditions, same wiring as the SDR ladder.
    if (multiAudio) {
      const pickedIdx =
        defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
          ? defaultAudioIndex
          : 0;
      const names = buildUniqueAudioNames(audioStreams);
      for (let i = 0; i < audioStreams.length; i++) {
        const a = audioStreams[i];
        const lang = a.language || 'und';
        const isDefault = i === pickedIdx ? 'YES' : 'NO';
        // CHANNELS hint matches Apple's reference master and lets
        // Tizen AVPlay pre-allocate the right audio decoder before
        // the variant playlist + init are fetched. Without it the
        // single-audio fMP4 path doesn't follow the rendition link
        // (issue #148 bisection — multi-audio works because AVPlay
        // probes the renditions, single-audio doesn't trigger the
        // probe when the hint is missing).
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${names[i]}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},CHANNELS="${audioRenditionChannels(outputAudioCodec, a.channels)}",URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
        );
      }
    }
    const hdrAudioAttr = multiAudio ? ',AUDIO="audio"' : '';
    pushSubtitleMedia(lines);

    // HEVC HDR rungs are pure transcodes (hevc_qsv Main10 with forced
    // 3-second keyframes), gated on `canEncodeHevcHdr`. The former
    // top "remux" pass-through was dropped: `-c:v copy` cuts on
    // existing source IDRs (variable durations) which mis-aligns with
    // the synthetic uniform-3s VOD playlist, and ExoPlayer's buffer
    // scheduler drifts behind audio. A transcode at ~28 Mbps Main10
    // is visually transparent and gives perfectly uniform segments.
    // Includes the source-resolution rung if there's an HDR profile
    // at or below source height.
    if (canEncodeHevcHdr) {
      const baseHdrLadder = getHdrLadderForDevice(deviceType).filter((p) =>
        profileFitsSource(p, sourceWidth, sourceHeight),
      );
      // Pin to the user-picked rung when `onlyQuality` is set so the
      // master exposes a single variant — AVPlayer / ExoPlayer have
      // no other rung to ABR-switch to and playback stays locked at
      // the chosen quality.
      const hdrLadder = applyQualityPin(
        baseHdrLadder,
        onlyQuality,
        sourceWidth,
        sourceHeight,
        /* hdrSuffix */ true,
      );
      for (const p of hdrLadder) {
        const avg =
          parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
        const bw = Math.round(avg * 1.5);
        const { width: w, height: h } = profileResolution(
          p,
          sourceWidth,
          sourceHeight,
        );
        // Level driven by luma sample rate (width × height × fps) so
        // cropped 4K sources (e.g. 3840×2024 cinemascope, height < 2160)
        // still get L5.x — height-only bucketing under-declared L4.1
        // for these and AVPlayer rejected every variant, surfacing as
        // NSURLErrorUnsupportedURL on iOS. Same rationale as the SDR
        // branch below.
        const videoCodec = hevcMain10CodecString({
          width: w,
          height: h,
          videoBitrateBps: 0,
          gopSize: 0,
          frameRate: sourceFrameRate,
        });
        lines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h},VIDEO-RANGE=${range}${frameRateAttr},NAME="${p.name}",CODECS="${videoCodec}${codecsTail}"${hdrAudioAttr}${subsAttr}`,
          `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
        );
      }
    }
    return lines.join('\n');
  }

  // Multi-audio: declare alternate audio renditions via EXT-X-MEDIA
  if (multiAudio) {
    const pickedIdx =
      defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
        ? defaultAudioIndex
        : 0;
    const names = buildUniqueAudioNames(audioStreams);
    for (let i = 0; i < audioStreams.length; i++) {
      const a = audioStreams[i];
      const lang = a.language || 'und';
      const isDefault = i === pickedIdx ? 'YES' : 'NO';
      // CHANNELS reports the rendition's real output layout (AAC downmixes
      // to 2 via `-ac 2`; copy / AC-3 / E-AC-3 keep the source layout) — Tizen
      // AVPlay uses this hint to pre-allocate the right audio decoder before
      // fetching the rendition. Without it the single-audio variant doesn't
      // trigger a rendition probe (issue #148 bisection).
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${names[i]}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},CHANNELS="${audioRenditionChannels(outputAudioCodec, a.channels)}",URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
      );
    }
  }

  // Always declare CODECS on EXT-X-STREAM-INF. For HLS-TS, this lets Shaka
  // skip fetching seg 0 purely to probe codecs (TS has no init segment) —
  // otherwise a user resuming mid-file wastes a transcode pass at seg 0
  // before the real seek-aware session starts at their resume position.
  // Video codec string is per-rung: H.264 High profile with a level high
  // enough for the rung's resolution at 60 fps. A single `avc1.640028`
  // (L4.0) for every rung makes iOS AVPlayer reject 4K segments whose
  // bitstream signals L5.x — visible as decoder reinit / frame freeze.
  const audioAttr = multiAudio ? ',AUDIO="audio"' : '';
  pushSubtitleMedia(lines);

  // The HLS master never advertises the `/remux/` variant — it proved
  // unreliable on ExoPlayer (Android), which would ABR-downgrade from the
  // remux rung to the identical-resolution 1080p transcode mid-stream and
  // trigger a pointless FFmpeg kill+restart. Transcode profiles cover the
  // full resolution ladder; "remux"/"original" quality picks are mapped
  // onto the top transcode profile.
  const ladder = getLadderForDevice(deviceType);
  let profiles = getAvailableProfiles(sourceWidth, sourceHeight, deviceType);
  if (!profiles.length) profiles.push(ladder[ladder.length - 1]); // at least 480p
  // Pin to the user-picked rung when `onlyQuality` is set so the
  // master exposes a single variant — AVPlayer / ExoPlayer have no
  // other rung to ABR-switch to and playback stays locked at the
  // chosen quality.
  profiles = applyQualityPin(profiles, onlyQuality, sourceWidth, sourceHeight);

  for (const p of profiles) {
    const avg =
      parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
    // BANDWIDTH must reflect the peak segment bitrate (HLS spec). With
    // `-maxrate == -b:v` the encoder is near-CBR but VBV bursts still
    // push individual segments ~30% above nominal. Declaring BANDWIDTH
    // ~1.5× nominal gives AVPlayer ABR a stable hysteresis margin and
    // stops it from down-/up-shifting on every VBV spike.
    const bw = Math.round(avg * 1.5);
    const { width: w, height: h } = profileResolution(
      p,
      sourceWidth,
      sourceHeight,
    );
    // Codec string MUST be derived from the actual emitted height (`h`),
    // not `p.maxHeight`. Cropped content (e.g. 2.39:1 cinemascope on a
    // 1920×1080 source → 1920×816) advertises a height below the
    // profile nominal, so `h264CodecString({height: 720})` would
    // declare avc1 L3.2 in the master while the bitstream SPS carries
    // L3.1 for the actual 1280×544 frames. The mismatch (declared > SPS)
    // can leave ExoPlayer's track selector stuck on cold prepare —
    // visible as the "buffering forever, no decoder allocated"
    // pattern on Android with cropped masters.
    const target = {
      width: w,
      height: h,
      videoBitrateBps: 0,
      gopSize: 0,
      frameRate: sourceFrameRate,
    };
    // Codec string must agree with what the encoder will actually emit —
    // mismatched CODECS makes Shaka fail with HLS_COULD_NOT_GUESS_CODECS
    // (3014) after it tries to sniff the segment and the bitstream
    // doesn't parse as the declared codec.
    const videoCodec =
      sdrVariant?.codec === 'hevc'
        ? hevcMainCodecString(target)
        : sdrVariant?.codec === 'av1'
          ? av1CodecString(target, sdrVariant.bitDepth)
          : h264CodecString(target);
    const codecsAttr = `,CODECS="${videoCodec}${codecsTail}"`;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h}${frameRateAttr},NAME="${p.name}"${codecsAttr}${audioAttr}${subsAttr}`,
      `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
    );
  }
  return lines.join('\n');
}

/** Build a unique NAME per audio rendition for `EXT-X-MEDIA`. When two
 *  tracks resolve to the same display string (typical case: MKV with two
 *  audio streams both falling back to `und` because the container left
 *  language + title empty), AVPlayer dedupes them into a single
 *  `AVMediaSelectionOption` and the user can no longer switch between
 *  them. Append `#2`, `#3`, … when the base name has already been used
 *  earlier in the list. */
function buildUniqueAudioNames(
  streams: { language?: string; title?: string }[],
): string[] {
  const seen = new Map<string, number>();
  return streams.map((s) => {
    const base = s.title || s.language || 'und';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} #${count}`;
  });
}

