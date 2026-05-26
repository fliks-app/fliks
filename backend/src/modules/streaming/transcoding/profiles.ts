import { bucketResolutionHeight } from '../../../common/utils/resolution.util';
import type { DeviceType, TranscodeProfile } from './types';

/** Threshold above which source bitrate earns its own "Original" rung
 *  alongside the transcode rung at the same resolution. */
export const ORIGINAL_SEPARATE_RATIO = 1.3;

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

/** Conservative mobile ladder — same resolutions, lower target bitrates
 *  so phones on cellular don't burn through data. Audio unchanged. */
export const MOBILE_PROFILES: TranscodeProfile[] = [
  {
    name: '2160p',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '8M',
    audioBitrate: '192k',
  },
  {
    name: '1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '3M',
    audioBitrate: '192k',
  },
  {
    name: '720p',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '1500k',
    audioBitrate: '128k',
  },
  {
    name: '480p',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: '800k',
    audioBitrate: '96k',
  },
  {
    name: '360p',
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: '500k',
    audioBitrate: '64k',
  },
  {
    name: '240p',
    maxWidth: 426,
    maxHeight: 240,
    videoBitrate: '300k',
    audioBitrate: '64k',
  },
  {
    name: '144p',
    maxWidth: 256,
    maxHeight: 144,
    videoBitrate: '150k',
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

export const MOBILE_HDR_PROFILES: TranscodeProfile[] = [
  {
    name: '2160p-hdr',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: '12M',
    audioBitrate: '192k',
  },
  {
    name: '1080p-hdr',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: '2200k',
    audioBitrate: '192k',
  },
  {
    name: '720p-hdr',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '1100k',
    audioBitrate: '128k',
  },
  {
    name: '480p-hdr',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: '600k',
    audioBitrate: '96k',
  },
];

export function getLadderForDevice(
  deviceType: DeviceType | undefined,
): TranscodeProfile[] {
  if (deviceType === 'mobile') return MOBILE_PROFILES;
  return DESKTOP_PROFILES;
}

/** HDR-preserving ladder. Stops at 480p — below that, HDR's visual
 *  benefit is moot and the encode cost isn't justified. */
export function getHdrLadderForDevice(
  deviceType: DeviceType | undefined,
): TranscodeProfile[] {
  if (deviceType === 'mobile') return MOBILE_HDR_PROFILES;
  return DESKTOP_HDR_PROFILES;
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

/** Compute output dimensions for a profile against a source. Width is
 *  capped at the source (no upscale); height follows the source aspect
 *  ratio, snapped UP to a multiple of 2 (HEVC/H.264 minimum encode
 *  granularity). We deliberately do NOT round to a multiple of 16:
 *  scale_vaapi treats `h=-16` as a divisibility hint, not a hard
 *  constraint, and Intel VPP/QSV happily emits source-height bitstreams
 *  (e.g. 1080 from a 1920×1080 source) regardless of what we declare.
 *  Rounding the master to 1088 while the bitstream stays at 1080 leaves
 *  Chrome MSE with a SourceBuffer dimensioned for 1088 receiving a 1080
 *  init.mp4 — appendBuffer is rejected as MEDIA_SOURCE_OPERATION_FAILED
 *  (Shaka 3014). Multiple-of-2 matches what every HEVC encoder we ship
 *  actually emits and keeps the master in sync. */
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
