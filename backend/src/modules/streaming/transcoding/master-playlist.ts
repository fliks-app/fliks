import {
  getHdrLadderForDevice,
  getLadderForDevice,
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
import { audioCodecString } from './codec/codec-strings';
import {
  buildUniqueAudioNames,
  emitAudioRenditions,
  emitVariantLadder,
  SDR_H264_VARIANT,
} from './hls-variant-ladder';

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
  /** When set, the master emits an HDR ladder instead of the SDR transcode
   *  ladder. `hdrVariant` is the codec the encoder pipeline resolved for this
   *  HDR source on the host (HEVC Main10 on QSV/VAAPI/NVENC/VideoToolbox,
   *  native AV1 HDR on NVENC Ada / libsvtav1); every rung's CODECS string is
   *  derived from it (`hvc1.2.4.*` for HEVC, `av01.*.10` for AV1). iOS
   *  AVPlayer / ExoPlayer use the `VIDEO-RANGE` attribute + the codec string
   *  to dispatch to the HDR rendering path. */
  hdrPassThrough?: {
    hdrFormat: 'HDR10' | 'HLG';
    hdrVariant: CodecVariant;
    videoBitRateBps?: number;
    audioBitRateBps?: number;
  },
  /** True when the registry has a probed-OK encoder for `hdrPassThrough.
   *  hdrVariant` on this host (the resolved codec + HDR format, with CPU
   *  fallback). When false the HDR ladder is skipped so the master never
   *  advertises HDR rungs whose segments the host can't actually produce —
   *  a `hvc1.*`/`av01.*` CODECS claim with no matching encoder trips a
   *  Media3 fallback-options crash on ExoPlayer / an MSE append reject. */
  canEmitHdrLadder = false,
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
  /** Probed (or estimated) source video bitrate + codec. Each transcode
   *  rung's declared BANDWIDTH is capped to the source (no upward inflation),
   *  matching the encode cap in `buildFfmpegArgs`. Omitted → no cap. */
  sourceVideoBitrateBps?: number,
  sourceVideoCodec?: string,
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

    // Each HDR variant references the shared `audio` group; renditions are
    // served from /audio/<i>/, same wiring as the SDR ladder.
    if (multiAudio) {
      emitAudioRenditions(
        lines,
        audioStreams,
        defaultAudioIndex,
        outputAudioCodec,
        mediaFileId,
        tokenParam,
      );
    }
    const hdrAudioAttr = multiAudio ? ',AUDIO="audio"' : '';
    pushSubtitleMedia(lines);

    // HDR rungs are pure transcodes (HEVC Main10 or native AV1 HDR with forced
    // keyframes), gated on `canEmitHdrLadder`. The former top "remux" pass-
    // through was dropped: `-c:v copy` cuts on existing source IDRs (variable
    // durations) which mis-aligns with the synthetic uniform VOD playlist, and
    // ExoPlayer's buffer scheduler drifts behind audio. A transcode is visually
    // transparent and gives perfectly uniform segments. Includes the source-
    // resolution rung if there's an HDR profile at or below source height.
    if (canEmitHdrLadder) {
      const hdrVariant = hdrPassThrough.hdrVariant;
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
      emitVariantLadder(lines, {
        profiles: hdrLadder,
        variant: hdrVariant,
        range,
        audioAttr: hdrAudioAttr,
        subsAttr,
        frameRateAttr,
        codecsTail,
        sourceWidth,
        sourceHeight,
        sourceFrameRate,
        sourceVideoBitrateBps,
        sourceVideoCodec,
        mediaFileId,
        tokenParam,
      });
    }
    return lines.join('\n');
  }

  // Multi-audio: declare alternate audio renditions via EXT-X-MEDIA
  if (multiAudio) {
    emitAudioRenditions(
      lines,
      audioStreams,
      defaultAudioIndex,
      outputAudioCodec,
      mediaFileId,
      tokenParam,
    );
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

  emitVariantLadder(lines, {
    profiles,
    variant: sdrVariant ?? SDR_H264_VARIANT,
    audioAttr,
    subsAttr,
    frameRateAttr,
    codecsTail,
    sourceWidth,
    sourceHeight,
    sourceFrameRate,
    sourceVideoBitrateBps,
    sourceVideoCodec,
    mediaFileId,
    tokenParam,
  });
  return lines.join('\n');
}


