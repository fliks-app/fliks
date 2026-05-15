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
  { name: '2160p', maxWidth: 3840, maxHeight: 2160, videoBitrate: '8M',  audioBitrate: '192k' },
  { name: '1080p', maxWidth: 1920, maxHeight: 1080, videoBitrate: '3M',  audioBitrate: '192k' },
  { name: '720p',  maxWidth: 1280, maxHeight: 720,  videoBitrate: '1500k', audioBitrate: '128k' },
  { name: '480p',  maxWidth: 854,  maxHeight: 480,  videoBitrate: '800k',  audioBitrate: '96k' },
  { name: '360p',  maxWidth: 640,  maxHeight: 360,  videoBitrate: '500k',  audioBitrate: '64k' },
  { name: '240p',  maxWidth: 426,  maxHeight: 240,  videoBitrate: '300k',  audioBitrate: '64k' },
  { name: '144p',  maxWidth: 256,  maxHeight: 144,  videoBitrate: '150k',  audioBitrate: '48k' },
];

/** HEVC HDR ladder — used when the source is HEVC HDR and the client
 *  declares HDR support. Names are suffixed `-hdr` so the URL routing,
 *  session cache keys, and admin dashboard can tell SDR and HDR rungs
 *  apart without ambiguity. Bitrates are roughly 70% of the H.264 SDR
 *  ladder — HEVC is ~30% more efficient at equivalent visual quality,
 *  so the file size matches what users expect from the rung label.
 *  Audio bitrates unchanged from the SDR ladder. */
export const DESKTOP_HDR_PROFILES: TranscodeProfile[] = [
  { name: '2160p-hdr', maxWidth: 3840, maxHeight: 2160, videoBitrate: '14M', audioBitrate: '192k' },
  { name: '1080p-hdr', maxWidth: 1920, maxHeight: 1080, videoBitrate: '5500k', audioBitrate: '192k' },
  { name: '720p-hdr',  maxWidth: 1280, maxHeight: 720,  videoBitrate: '2800k', audioBitrate: '128k' },
  { name: '480p-hdr',  maxWidth: 854,  maxHeight: 480,  videoBitrate: '1400k', audioBitrate: '96k' },
];

export const MOBILE_HDR_PROFILES: TranscodeProfile[] = [
  { name: '2160p-hdr', maxWidth: 3840, maxHeight: 2160, videoBitrate: '6M',    audioBitrate: '192k' },
  { name: '1080p-hdr', maxWidth: 1920, maxHeight: 1080, videoBitrate: '2200k', audioBitrate: '192k' },
  { name: '720p-hdr',  maxWidth: 1280, maxHeight: 720,  videoBitrate: '1100k', audioBitrate: '128k' },
  { name: '480p-hdr',  maxWidth: 854,  maxHeight: 480,  videoBitrate: '600k',  audioBitrate: '96k' },
];

export function getLadderForDevice(deviceType: DeviceType | undefined): TranscodeProfile[] {
  if (deviceType === 'mobile') return MOBILE_PROFILES;
  return DESKTOP_PROFILES;
}

/** HDR-preserving ladder. Stops at 480p — below that, HDR's visual
 *  benefit is moot and the encode cost isn't justified. */
export function getHdrLadderForDevice(deviceType: DeviceType | undefined): TranscodeProfile[] {
  if (deviceType === 'mobile') return MOBILE_HDR_PROFILES;
  return DESKTOP_HDR_PROFILES;
}

/** True when a profile name belongs to the HEVC HDR ladder. Drives the
 *  encoder dispatch in ffmpeg-args (hevc_qsv Main10) and the CODECS
 *  string emission in master-playlist (hvc1.* + VIDEO-RANGE=PQ). */
export function isHdrProfile(name: string): boolean {
  return name.endsWith('-hdr');
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
