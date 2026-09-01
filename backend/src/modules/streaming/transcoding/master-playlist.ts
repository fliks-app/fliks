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
import {
  IFRAME_CODEC,
  iframeBandwidthBps,
  iframeResolution,
} from './iframe-trick-play';
import { audioCodecString } from './codec/codec-strings';
import {
  buildUniqueAudioNames,
  emitAudioRenditions,
  emitVariantLadder,
  SDR_H264_VARIANT,
} from './hls-variant-ladder';

/** BANDWIDTH for the remux variant when the source carries no probed bitrate.
 *  Only a manifest formality: the variant is alone, so nothing selects on it. */
const REMUX_FALLBACK_BANDWIDTH_BPS = 8_000_000;

/** Format frame rate for the HLS `FRAME-RATE` attribute. Apple's spec
 *  says "decimal-floating-point describing the maximum frame rate …
 *  rounded to three decimal places". Whole numbers stay integer to
 *  match Apple's reference manifests (e.g. `60`, not `60.000`). */
function formatFrameRate(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/** The single profile a collapsed ladder falls back to: the highest rung
 *  that fits the source resolution (no upscale), delegated to
 *  {@link profileFitsSource} (bucket on both axes) so anamorphic or scope
 *  crops (e.g. 1918×872) keep their 1080p top rung. */
function topFittingProfile(
  ladder: TranscodeProfile[],
  sourceWidth: number,
  sourceHeight: number,
): TranscodeProfile {
  return (
    ladder.find((p) => profileFitsSource(p, sourceWidth, sourceHeight)) ??
    ladder[0]
  );
}

/** Collapse the ladder to a single variant when the client can't be trusted
 *  to stay on one rung: an explicit `onlyQuality` URL pin (saved preference
 *  / dropdown pick), or — with no pin — a device profile that declared
 *  `supportsAbr: false` (the client picks one HLS variant when it opens the
 *  master and never switches again, e.g. embedded mpv). A full ladder
 *  handed to either makes the player's HLS demuxer touch every variant
 *  playlist/init segment at open; each touch carries a different `quality`,
 *  and since there's no per-rung session key, each fetch kills + respawns
 *  ffmpeg for the last-touched rung — a self-sustaining restart storm. Used
 *  identically by the SDR and HDR branches.
 *
 *  - `remux` / `original`, or no pin with `supportsAbr: false`, collapse to
 *    {@link topFittingProfile} in both the SDR and HDR ladders.
 *  - When `hdrSuffix` is true, an input `1080p` is matched against
 *    `1080p-hdr` (HDR ladder rungs carry the suffix); already
 *    `*-hdr` inputs pass through unchanged.
 *  - An explicit `onlyQuality` always wins over `supportsAbr`.
 *  - Falls back to the full ladder when the pin doesn't match any
 *    rung (a stale saved link, a typo). */
function applyQualityPin(
  ladder: TranscodeProfile[],
  onlyQuality: string | undefined,
  sourceWidth: number,
  sourceHeight: number,
  hdrSuffix = false,
  supportsAbr = true,
): TranscodeProfile[] {
  if (!onlyQuality) {
    return supportsAbr
      ? ladder
      : [topFittingProfile(ladder, sourceWidth, sourceHeight)];
  }
  if (onlyQuality === 'remux' || onlyQuality === 'original') {
    return [topFittingProfile(ladder, sourceWidth, sourceHeight)];
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

export interface MasterPlaylistOptions {
  mediaFileId: number;
  sourceWidth: number;
  sourceHeight: number;
  tokenParam: string;
  includeRemux?: boolean;
  sourceBitrate?: number;
  audioStreams?: AudioStreamMeta[];
  /** Resolved per-track output channel count (aligned with `audioStreams`):
   *  source count when copied, downmix target when transcoded. Drives the
   *  rendition CHANNELS attribute; codec-derived fallback when absent. */
  audioOutputChannels?: (number | undefined)[];
  onlyQuality?: string;
  defaultAudioIndex?: number;
  deviceType?: DeviceType;
  /** Output audio codec ffmpeg emits; the CODECS attribute must match it or the
   *  receiver rejects the segment on MSE append. `aac` | `ac3` | `eac3`. */
  outputAudioCodec?: string;
  /** Real output audio bitrate (bps) for each rung's BANDWIDTH; profile nominal
   *  fallback when absent (undercounts the fixed-640k AC-3/E-AC-3 path). */
  audioOutputBitrateBps?: number;
  /** When set, emit an HDR ladder (gated by `canEmitHdrLadder`); `hdrVariant`
   *  drives every rung's CODECS + VIDEO-RANGE. */
  hdrPassThrough?: {
    hdrFormat: 'HDR10' | 'HLG';
    hdrVariant: CodecVariant;
    videoBitRateBps?: number;
    audioBitRateBps?: number;
  };
  /** Host has a probed-OK encoder for `hdrPassThrough.hdrVariant`; false skips
   *  the HDR ladder so the master never advertises rungs it can't produce. */
  canEmitHdrLadder?: boolean;
  /** SDR-ladder output codec from the selector (HEVC promotion → `hvc1.*`). */
  sdrVariant?: CodecVariant;
  /** Source fps for the `FRAME-RATE` attribute — required on HDR rungs (Apple
   *  rejects PQ/HLG rungs without it). */
  sourceFrameRate?: number;
  /** Text subtitle tracks to advertise as a `SUBTITLES` rendition group. */
  subtitleRenditions?: SubtitleRenditionMeta[];
  /** Source video bitrate + codec; caps each rung's declared BANDWIDTH. */
  sourceVideoBitrateBps?: number;
  sourceVideoCodec?: string;
  /** Client can switch HLS variants at runtime (real ABR). `false` collapses
   *  the ladder to {@link topFittingProfile} when there's no explicit
   *  `onlyQuality` pin — see {@link applyQualityPin}. Missing/undefined
   *  defaults to `true` (existing full-ladder behaviour). */
  supportsAbr?: boolean;
  /** RFC 6381 CODECS for the copied source, published with the remux variant
   *  ({@link includeRemux}). `null`/absent omits the attribute so the player
   *  probes the real bytes — never substitute a rung-derived string here, a
   *  copy must not be described by the encoder's arithmetic. */
  remuxCodecs?: string | null;
  /** Container total bitrate for the remux variant's BANDWIDTH. Needed
   *  separately from {@link sourceBitrate}, which sums per-stream bitrates and
   *  collapses to the audio track alone on a source (MKV, typically) that
   *  declares no per-stream video bitrate. */
  remuxBandwidthBps?: number;
  /** Segment grid length, in seconds, of the trick-play rendition to advertise.
   *  Unset omits it: only AVPlay needs the `EXT-X-I-FRAME-STREAM-INF` tag, and
   *  every player that reads one will fetch the frames behind it. */
  iFrameTrickPlaySegmentSeconds?: number;
}

/** Generate the HLS master playlist listing available qualities. */
export function generateMasterPlaylist(opts: MasterPlaylistOptions): string {
  const {
    mediaFileId,
    sourceWidth,
    sourceHeight,
    tokenParam,
    includeRemux = false,
    sourceBitrate,
    audioStreams,
    audioOutputChannels,
    onlyQuality,
    defaultAudioIndex = 0,
    deviceType = 'desktop',
    outputAudioCodec = 'aac',
    audioOutputBitrateBps,
    hdrPassThrough,
    canEmitHdrLadder = false,
    sdrVariant,
    sourceFrameRate = 24,
    subtitleRenditions,
    sourceVideoBitrateBps,
    sourceVideoCodec,
    supportsAbr = true,
    iFrameTrickPlaySegmentSeconds,
    remuxCodecs,
    remuxBandwidthBps,
  } = opts;
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

  const pushIFrameStream = (out: string[]): void => {
    if (!iFrameTrickPlaySegmentSeconds) return;
    const { width, height } = iframeResolution(sourceWidth, sourceHeight);
    const bw = iframeBandwidthBps(iFrameTrickPlaySegmentSeconds);
    out.push(
      `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${width}x${height},CODECS="${IFRAME_CODEC}",URI="/api/stream/${mediaFileId}/iframe/index.m3u8${tokenParam}"`,
    );
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
        supportsAbr,
      );
      emitVariantLadder(lines, {
        profiles: hdrLadder,
        variant: hdrVariant,
        range,
        audioAttr: hdrAudioAttr,
        audioBitrateBps: hdrPassThrough.audioBitRateBps ?? audioOutputBitrateBps,
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
    pushIFrameStream(lines);
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
      audioOutputChannels,
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

  // Copy path (`?remux=1`, set only by a DirectStream decision): publish the
  // remux variant ALONE. Pairing it with the ladder is what made ExoPlayer
  // ABR-downgrade to the identical-resolution 1080p transcode and kill+respawn
  // ffmpeg; with a single variant there is no rung to switch to. A user who
  // wants a lighter rung pins one, which arrives here as `onlyQuality` and
  // takes the ladder branch below.
  if (includeRemux && !onlyQuality) {
    // BANDWIDTH is required and must be a peak, so keep the ladder's 1.5x
    // convention over the source average; the fallback only fires when ffprobe
    // reported no bitrate at all.
    const avg =
      Math.round(remuxBandwidthBps || sourceBitrate || sourceVideoBitrateBps || 0) ||
      REMUX_FALLBACK_BANDWIDTH_BPS;
    const codecsAttr = remuxCodecs ? `,CODECS="${remuxCodecs}${codecsTail}"` : '';
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(avg * 1.5)},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${sourceWidth}x${sourceHeight}${frameRateAttr},NAME="remux"${codecsAttr}${audioAttr}${subsAttr}`,
      `/api/stream/${mediaFileId}/remux/index.m3u8${tokenParam}`,
    );
    pushIFrameStream(lines);
    return lines.join('\n');
  }

  const ladder = getLadderForDevice(deviceType);
  let profiles = getAvailableProfiles(sourceWidth, sourceHeight, deviceType);
  if (!profiles.length) profiles.push(ladder[ladder.length - 1]); // at least 480p
  // Pin to the user-picked rung when `onlyQuality` is set so the
  // master exposes a single variant — AVPlayer / ExoPlayer have no
  // other rung to ABR-switch to and playback stays locked at the
  // chosen quality.
  profiles = applyQualityPin(
    profiles,
    onlyQuality,
    sourceWidth,
    sourceHeight,
    /* hdrSuffix */ false,
    supportsAbr,
  );

  emitVariantLadder(lines, {
    profiles,
    variant: sdrVariant ?? SDR_H264_VARIANT,
    audioAttr,
    audioBitrateBps: audioOutputBitrateBps,
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
  pushIFrameStream(lines);
  return lines.join('\n');
}


