import { parseBitrateToBps, profileResolution } from './profiles';
import {
  audioRenditionChannels,
  av1CodecString,
  h264CodecString,
  hevcMain10CodecString,
  hevcMainCodecString,
} from './codec/codec-strings';
import { cappedRungVideoBitrateBps } from './quality-ladder';
import type { CodecVariant, EncoderTarget } from './codec/types';
import type { AudioStreamMeta, TranscodeProfile } from './types';

/** SDR fallback variant for legacy callers that don't thread `sdrVariant`
 *  (H.264 High 8-bit). Keeps the codec-string + bitrate-cap behaviour identical
 *  to the pre-variant default (`h264` has CODEC_BITRATE_FACTOR 1, same as the
 *  former `undefined` target codec). */
export const SDR_H264_VARIANT: CodecVariant = {
  codec: 'h264',
  bitDepth: 8,
  hdr: null,
};

/** RFC 6381 CODECS string for a rung, picked from the resolved output variant:
 *  AV1 at its bit depth, HEVC Main10 for HDR / Main for SDR, H.264 otherwise.
 *  Single source of truth shared by the HDR and SDR ladders so the manifest
 *  never declares a codec the segments don't carry. */
function videoCodecString(
  variant: CodecVariant,
  target: EncoderTarget,
): string {
  if (variant.codec === 'av1') return av1CodecString(target, variant.bitDepth);
  if (variant.codec === 'hevc')
    return variant.hdr != null
      ? hevcMain10CodecString(target)
      : hevcMainCodecString(target);
  return h264CodecString(target);
}

/** Build a unique NAME per rendition for `EXT-X-MEDIA` (audio or subtitle).
 *  When two tracks resolve to the same display string (typical case: MKV with
 *  two audio streams both falling back to `und` because the container left
 *  language + title empty), AVPlayer dedupes them into a single
 *  `AVMediaSelectionOption` and the user can no longer switch between them.
 *  Append `#2`, `#3`, … when the base name has already been used earlier. */
export function buildUniqueAudioNames(
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

/** Emit one `EXT-X-MEDIA:TYPE=AUDIO` rendition per source audio stream, sharing
 *  the `audio` group. CHANNELS reports the rendition's real output layout —
 *  Tizen AVPlay needs the hint to pre-allocate the decoder before fetching the
 *  rendition, else the single-audio fMP4 path never follows the rendition link
 *  (issue #148). `outputChannels[i]` is the resolved per-track output count
 *  (copy keeps the source, transcode downmixes); falls back to a codec-derived
 *  guess when the plan isn't threaded. */
export function emitAudioRenditions(
  lines: string[],
  audioStreams: AudioStreamMeta[],
  defaultAudioIndex: number,
  outputAudioCodec: string,
  mediaFileId: number,
  tokenParam: string,
  outputChannels?: (number | undefined)[],
): void {
  const pickedIdx =
    defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
      ? defaultAudioIndex
      : 0;
  const names = buildUniqueAudioNames(audioStreams);
  for (let i = 0; i < audioStreams.length; i++) {
    const a = audioStreams[i];
    const lang = a.language || 'und';
    const isDefault = i === pickedIdx ? 'YES' : 'NO';
    const channels =
      outputChannels?.[i] ?? audioRenditionChannels(outputAudioCodec, a.channels);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${names[i]}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},CHANNELS="${channels}",URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
    );
  }
}

export interface VariantLadderOptions {
  profiles: TranscodeProfile[];
  /** Resolved output variant — drives the codec string + the bitrate cap. */
  variant: CodecVariant;
  /** VIDEO-RANGE attribute value; omitted (SDR) leaves the attribute off. */
  range?: 'PQ' | 'HLG';
  audioAttr: string;
  /** Real output audio bitrate (bps) for the BANDWIDTH/AVERAGE-BANDWIDTH sum.
   *  Falls back to the per-rung profile nominal when absent — which undercounts
   *  AC-3/E-AC-3 (encoded at a fixed 640k, far above the nominal). */
  audioBitrateBps?: number;
  subsAttr: string;
  frameRateAttr: string;
  codecsTail: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceFrameRate: number;
  sourceVideoBitrateBps: number | undefined;
  sourceVideoCodec: string | undefined;
  mediaFileId: number;
  tokenParam: string;
}

/** Emit one `EXT-X-STREAM-INF` + URI per rung for a single resolved output
 *  variant. Drives the HDR and SDR ladders through one path — they differ only
 *  in the ladder, the VIDEO-RANGE attribute and the codec string, all derived
 *  from `variant`. The per-rung level and Main-tier bitrate clamp are computed
 *  from the actual emitted resolution (cropped scope content sits below the
 *  profile nominal) so the declared CODECS level + tier match the bitstream. */
export function emitVariantLadder(
  lines: string[],
  opts: VariantLadderOptions,
): void {
  const {
    profiles,
    variant,
    range,
    audioAttr,
    audioBitrateBps,
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
  } = opts;
  const rangeAttr = range ? `,VIDEO-RANGE=${range}` : '';
  for (const p of profiles) {
    const { width: w, height: h } = profileResolution(
      p,
      sourceWidth,
      sourceHeight,
    );
    const cappedVideo = cappedRungVideoBitrateBps(p, {
      outputCodec: variant.codec,
      sourceWidth,
      sourceHeight,
      sourceFrameRate,
      sourceVideoBitrateBps,
      sourceVideoCodec,
    });
    const avg =
      cappedVideo + (audioBitrateBps ?? parseBitrateToBps(p.audioBitrate));
    // BANDWIDTH ~1.5x nominal: with -maxrate == -b:v the encoder is near-CBR but
    // VBV bursts push segments ~30% above nominal; the margin gives AVPlayer ABR
    // stable hysteresis.
    const bw = Math.round(avg * 1.5);
    const target = {
      width: w,
      height: h,
      videoBitrateBps: 0,
      gopSize: 0,
      frameRate: sourceFrameRate,
    };
    const codec = videoCodecString(variant, target);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h}${rangeAttr}${frameRateAttr},NAME="${p.name}",CODECS="${codec}${codecsTail}"${audioAttr}${subsAttr}`,
      `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
    );
  }
}
