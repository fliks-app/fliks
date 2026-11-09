import type { DirectPlayProfile } from './browser-device-profile.service';
import type { WebVideo } from './device-capabilities/web-video';

/** What the TV reports about itself; every field is absent where the firmware does not say. */
export interface WebOsDevice {
  /** Model year of the webOS TV release (LG: 6.0 is 2021, webOS TV 25 is 2025). */
  year: number | null;
  /** Panel wider than Full HD (LG "Ultra HD models"). */
  uhd: boolean | null;
  hdr10: boolean | null;
  dolbyVision: boolean | null;
}

interface DeviceInfo {
  platformVersion?: string;
  version?: string;
  sdkVersion?: string;
  screenWidth?: number;
  uhd?: boolean | string;
  hdr10?: boolean | string;
  dolbyVision?: boolean | string;
}

const flag = (v: boolean | string | undefined): boolean | null =>
  v === undefined ? null : v === true || v === 'true';

/** Model year of a webOS TV platform major version (LG release table: 3.x 2016-17, 4.x 2018-19, 5.0 2020, 6.0 2021, then 7.0 is webOS TV 22). */
function yearOfPlatform(major: number): number {
  return major >= 6 ? 2015 + major : ({ 3: 2016, 4: 2018, 5: 2020 } as Record<number, number>)[major] ?? 2016;
}

/** The Chromium major each webOS TV release ships (LG web engine spec), newest first. */
const CHROMIUM_YEAR: ReadonlyArray<[chromium: number, year: number]> = [
  [132, 2026], [120, 2025], [108, 2024], [94, 2023], [87, 2022], [79, 2021], [68, 2020], [53, 2018],
];

/** `webOSSystem.deviceInfo` (a JSON string), completed by the Chromium version when the firmware omits the platform. */
export function webosDevice(): WebOsDevice | null {
  const w = window as unknown as { webOSSystem?: { deviceInfo?: unknown }; PalmSystem?: { deviceInfo?: unknown } };
  let info: DeviceInfo = {};
  try {
    const raw = w.webOSSystem?.deviceInfo ?? w.PalmSystem?.deviceInfo;
    info = (typeof raw === 'string' ? JSON.parse(raw) : raw) ?? {};
  } catch {
    // No device info: the Chromium version still dates the TV.
  }
  const platform = /^(\d+)/.exec(info.platformVersion ?? info.sdkVersion ?? info.version ?? '');
  const chromium = Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1]);
  const year = platform
    ? yearOfPlatform(Number(platform[1]))
    : (CHROMIUM_YEAR.find(([c]) => chromium >= c)?.[1] ?? null);
  const uhd = flag(info.uhd) ?? (typeof info.screenWidth === 'number' ? info.screenWidth >= 3840 : null);
  return { year, uhd, hdr10: flag(info.hdr10), dolbyVision: flag(info.dolbyVision) };
}

/** LG's "Video and Audio Format" tables, every webOS TV release from 3.0 to 26: HEVC and MP3 are listed in `.mp4` and `.mkv` for all of them.
 * https://webostv.developer.lge.com/develop/specifications/video-audio-250 */
export function webosAudioCodecs(probed: string[]): string[] {
  return probed.includes('mp3') ? probed : [...probed, 'mp3'];
}

/** HEVC is in every release's table, so a probe that misses it does not remove it. */
export function webosVideo(probed: WebVideo): WebVideo {
  if (probed.videoCodecs.includes('hevc')) return probed;
  return {
    ...probed,
    videoCodecs: [...probed.videoCodecs, 'hevc', 'h265', 'hvc1'],
    codecConditions: [...probed.codecConditions, { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 }],
  };
}

/** `.mkv` only opens in the native pipeline (`canPlayType` and MSE refuse it), so no probe sees it: LG's per-release tables decide.
 * Ultra HD models list H.264 and HEVC with DD, DD+ and AAC only; other panels the full `.mkv` row (AV1 from 2020, Opus from 2024). */
export function webosMkvProfile(device: WebOsDevice | null): DirectPlayProfile {
  const year = device?.year ?? 0;
  const full = device?.uhd === false;
  const video = ['h264', 'avc1', 'hevc', 'h265', 'hvc1'];
  const audio = ['ac3', 'eac3', 'aac'];
  if (full) {
    video.push('vp9');
    if (year >= 2020) video.push('av1');
    audio.push('mp3');
    if (year >= 2024) audio.push('opus');
  }
  return { containers: ['mkv', 'matroska'], videoCodecs: video, audioCodecs: audio };
}
