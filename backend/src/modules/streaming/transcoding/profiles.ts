import { bucketResolutionHeight } from '../../../common/utils/resolution.util';
import type { DeviceType, TranscodeProfile } from './types';

/** Output bitrate for surround AC-3 / E-AC-3 transcodes (the encoders' 5.1
 *  ceiling). Single source for the encoder `-b:a` arg and the master-playlist
 *  BANDWIDTH so the declared and produced bitrates can't drift apart. */
export const SURROUND_TRANSCODE_BITRATE_BPS = 640_000;

/** Relative bits to reach a given visual quality, normalised to H.264 = 1.
 *  A less-efficient target codec needs proportionally more bits than the
 *  source to hold the same quality (HEVC/AV1 are more efficient → fewer bits). */
const CODEC_BITRATE_FACTOR: Record<string, number> = {
  h264: 1,
  avc: 1,
  avc1: 1,
  hevc: 0.6,
  h265: 0.6,
  hvc1: 0.6,
  hev1: 0.6,
  vp9: 0.7,
  av1: 0.5,
  av01: 0.5,
};

/**
 * Source video bitrate in bps: the probed per-stream value, or an estimate
 * from the container bitrate when the stream omits it (common in MKV, where
 * ffprobe leaves the per-stream bitrate unset). Audio is subtracted when its
 * bitrate is known; when the container omits that too, the overall container
 * bitrate stands as the video estimate — a hair generous but a far better cap
 * than the ladder nominal. Returns undefined when no container bitrate is
 * known. Shared by the stream-builder decision and the session context so the
 * encode cap and the overlay agree on the source bitrate.
 */
export function resolveSourceVideoBitrateBps(
  videoStreamBitrateBps: number | null | undefined,
  formatBitrateBps: number | null | undefined,
  audioSumBitrateBps: number,
): number | undefined {
  if (videoStreamBitrateBps != null && videoStreamBitrateBps > 0) {
    return videoStreamBitrateBps;
  }
  if (formatBitrateBps != null && formatBitrateBps > 0) {
    const est = formatBitrateBps - Math.max(0, audioSumBitrateBps);
    if (est > 10_000) return est;
  }
  return undefined;
}

/**
 * Cap a ladder rung's video bitrate to what the source actually needs, so a
 * forced transcode (crop, explicit rung, …) never *inflates* the bitrate above
 * the source — re-encoding a 2 Mbps source up to an 8 Mbps rung burns CPU and
 * bandwidth for no quality gain (you can't recover detail the source lacks).
 * The ceiling scales with codec efficiency (a less-efficient target gets
 * proportionally more bits to hold the same quality) and never drops below the
 * source bitrate, so the rung still wins whenever it is the lower of the two.
 * Returns the rung bitrate unchanged when the source bitrate is unknown.
 */
export function cappedTranscodeVideoBitrateBps(
  rungBitrateBps: number,
  sourceVideoBitrateBps: number | null | undefined,
  sourceCodec: string | null | undefined,
  targetCodec: string | null | undefined,
): number {
  if (!sourceVideoBitrateBps || sourceVideoBitrateBps <= 0) {
    return rungBitrateBps;
  }
  const src = CODEC_BITRATE_FACTOR[(sourceCodec ?? '').toLowerCase()] ?? 1;
  const tgt = CODEC_BITRATE_FACTOR[(targetCodec ?? '').toLowerCase()] ?? 1;
  const headroom = Math.max(1, tgt / src);
  return Math.min(rungBitrateBps, Math.round(sourceVideoBitrateBps * headroom));
}

export const DESKTOP_PROFILES: TranscodeProfile[] = [
  {
    name: '2160p',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '20M',
    audioBitrate: '192k',
  },
  {
    name: '1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '8M',
    audioBitrate: '192k',
  },
  {
    name: '720p',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '4M',
    audioBitrate: '128k',
  },
  {
    name: '480p',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: '2M',
    audioBitrate: '96k',
  },
  {
    name: '360p',
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: '1M',
    audioBitrate: '64k',
  },
  {
    name: '240p',
    maxWidth: 426,
    maxHeight: 240,
    videoBitrate: '500k',
    audioBitrate: '64k',
  },
  {
    name: '144p',
    maxWidth: 256,
    maxHeight: 144,
    videoBitrate: '200k',
    audioBitrate: '48k',
  },
];

/** HEVC HDR ladder — used when the source is HEVC HDR and the client
 *  declares HDR support. Names are suffixed `-hdr` so the URL routing,
 *  session cache keys, and admin dashboard can tell SDR and HDR rungs
 *  apart without ambiguity. Bitrates are roughly 70% of the H.264 SDR
 *  ladder — HEVC is ~30% more efficient at equivalent visual quality,
 *  so the file size matches what users expect from the rung label.
 *  Audio bitrates unchanged from the SDR ladder. */
export const DESKTOP_HDR_PROFILES: TranscodeProfile[] = [
  // 2160p-hdr replaces the former HEVC HDR "remux" pass-through at the
  // top of the HDR ladder. Pure `-c:v copy` is incompatible with the
  // synthetic uniform-3s VOD playlist (segments cut at every source
  // IDR → variable durations 1–10 s+), and re-encode forces predictable
  // 3 s segments via `-force_key_frames`. 28 Mbps HEVC Main10 is
  // visually transparent vs typical 50–80 Mbps source 4K HDR — the
  // re-encode preserves HDR10/HLG signaling end-to-end.
  {
    name: '2160p-hdr',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '28M',
    audioBitrate: '192k',
  },
  {
    name: '1080p-hdr',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '5500k',
    audioBitrate: '192k',
  },
  {
    name: '720p-hdr',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '2800k',
    audioBitrate: '128k',
  },
  {
    name: '480p-hdr',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: '1400k',
    audioBitrate: '96k',
  },
];

/** Low-consumption ("faible consommation") rungs. Shared by every device:
 *  the full ladder plus these eco rungs make one menu, and clients pick an
 *  eco rung (or default to it) to save bandwidth. The `eco-` prefix
 *  keeps URL routing / session keys distinct from the regular `1080p` rung. */
export const ECO_PROFILES: TranscodeProfile[] = [
  {
    name: 'eco-2160p',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '8M',
    audioBitrate: '192k',
  },
  {
    name: 'eco-1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '3M',
    audioBitrate: '192k',
  },
  {
    name: 'eco-720p',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '1500k',
    audioBitrate: '128k',
  },
];

export const ECO_HDR_PROFILES: TranscodeProfile[] = [
  {
    name: 'eco-2160p-hdr',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '12M',
    audioBitrate: '192k',
  },
  {
    name: 'eco-1080p-hdr',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '2200k',
    audioBitrate: '192k',
  },
];

/** True for a low-consumption rung (the desktop-only `eco-*` tier). */
export function isEcoProfile(name: string): boolean {
  return name.startsWith('eco-');
}

/** Unified ladder for every device: the full-quality rungs plus the
 *  low-consumption `eco-*` rungs. Desktop and mobile expose the same menu;
 *  data-conscious clients pick an eco rung (or default to it via the player
 *  setting) instead of getting a silently-capped ladder. `deviceType` is kept
 *  for signature stability but no longer branches the ladder. */
export function getLadderForDevice(
  deviceType: DeviceType | undefined,
): TranscodeProfile[] {
  void deviceType;
  return [...DESKTOP_PROFILES, ...ECO_PROFILES];
}

/** HDR-preserving ladder (full + eco). Stops at 480p — below that, HDR's
 *  visual benefit is moot and the encode cost isn't justified. */
export function getHdrLadderForDevice(
  deviceType: DeviceType | undefined,
): TranscodeProfile[] {
  void deviceType;
  return [...DESKTOP_HDR_PROFILES, ...ECO_HDR_PROFILES];
}

/** True when a profile name belongs to the HEVC HDR ladder. Drives the
 *  encoder dispatch in ffmpeg-args (hevc_qsv Main10) and the CODECS
 *  string emission in master-playlist (hvc1.* + VIDEO-RANGE=PQ). */
export function isHdrProfile(name: string): boolean {
  return name.endsWith('-hdr');
}

/** True when a profile is small enough to encode on the source. Compares
 *  the *bucketed* heights on both sides so anamorphic / scope / IMAX
 *  crops snap to the right rung — the previous `<=` on either axis
 *  rescued IMAX 4K (3840×2024) but still dropped letterboxed 1080p
 *  masters like 1918×872 to the 720p rung because both axes sat one or
 *  two pixels under the round number. See {@link bucketResolutionHeight}
 *  for the bucket boundaries. */
export function profileFitsSource(
  p: { maxWidth: number; maxHeight: number },
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  return (
    bucketResolutionHeight(p.maxWidth, p.maxHeight) <=
    bucketResolutionHeight(sourceWidth, sourceHeight)
  );
}

/** Compute output dimensions for a profile against a source. Width is capped
 *  at the source (no upscale); height follows the source aspect ratio, snapped
 *  UP to a multiple of 2 — the 4:2:0 codec minimum and the standard streaming
 *  rung (1920x1080, not 1088). Every encoder's scale filter rounds to mod-2 too
 *  (`scaleEvenHeight`, `scale_*=h=-2`), so the master `RESOLUTION` matches the
 *  bitstream's display size exactly. mod-16 is only the encoder's internal
 *  macroblock/CTU grid (cropped back via the conformance window) — it is never
 *  an output dimension; rounding the master to it would advertise 1088 with a
 *  136:135 SAR that no encoder actually produces. */
export function profileResolution(
  p: { maxWidth: number },
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const width = Math.min(p.maxWidth, sourceWidth);
  const rawH = (width * sourceHeight) / sourceWidth;
  const height = Math.max(2, Math.ceil(rawH / 2) * 2);
  return { width, height };
}

/** Backward-compatible alias — most callers want the desktop ladder. */
export const PROFILES = DESKTOP_PROFILES;

/** Parse FFmpeg-style rates like '8M', '500k', '192k' to bits per second. */
export function parseBitrateToBps(s: string): number {
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (u === 'm') return Math.round(n * 1e6);
  if (u === 'k') return Math.round(n * 1e3);
  return Math.round(n);
}
