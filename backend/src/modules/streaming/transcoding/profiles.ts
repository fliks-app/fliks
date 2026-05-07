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

export function getLadderForDevice(deviceType: DeviceType | undefined): TranscodeProfile[] {
  if (deviceType === 'mobile') return MOBILE_PROFILES;
  return DESKTOP_PROFILES;
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
