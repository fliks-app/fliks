/** Samsung's `webapis.systeminfo` codec API: synchronous and answers for the AVPlay decoders, unlike the WebView's MSE probe; containers have no equivalent.
 * https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/systeminfo-api.html */

import type { CodecCondition } from './browser-device-profile.service';
import type { WebVideo } from './device-capabilities/web-video';

interface TizenSystemInfo {
  isSupportedAudioCodec?(codec: string): boolean;
  isSupportedVideoCodec?(codec: string): boolean;
}

interface TizenProductInfo {
  isUdPanelSupported?(): boolean;
  is8KPanelSupported?(): boolean;
}

/** Fliks codec id to Samsung enum, for codecs the backend can copy into HLS. */
const AUDIO_ENUM: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC3',
  eac3: 'E-AC3',
  opus: 'OPUS',
};

/** Absent from AVPlay's container audio list (Samsung media spec), whatever the MSE probe says. */
const AVPLAY_UNSUPPORTED_AUDIO = ['flac', 'alac'];

function webapis(): { systeminfo?: TizenSystemInfo; productinfo?: TizenProductInfo } | null {
  return (window as unknown as { webapis?: { systeminfo?: TizenSystemInfo; productinfo?: TizenProductInfo } })
    .webapis ?? null;
}

/** `null` when the firmware doesn't expose the call, so callers keep their
 *  existing answer instead of treating a missing API as "unsupported". */
function isSupported(kind: 'audio' | 'video', name: string): boolean | null {
  const si = webapis()?.systeminfo;
  const fn = kind === 'audio' ? si?.isSupportedAudioCodec : si?.isSupportedVideoCodec;
  if (typeof fn !== 'function') return null;
  try {
    return !!fn.call(si, name);
  } catch {
    return null;
  }
}

/** The API decides every codec it enumerates, the rest pass through; returns the input unchanged when the API is unavailable. */
export function applyTizenAudioCodecs(probed: string[]): string[] {
  const kept = probed.filter((c) => !AVPLAY_UNSUPPORTED_AUDIO.includes(c));
  const merged = kept.filter((c) => !(c in AUDIO_ENUM));
  let answered = false;
  for (const [codec, samsungName] of Object.entries(AUDIO_ENUM)) {
    const supported = isSupported('audio', samsungName);
    if (supported === null) {
      if (kept.includes(codec)) merged.push(codec);
      continue;
    }
    answered = true;
    if (supported) merged.push(codec);
  }
  return answered ? merged : kept;
}

/** AVPlay decoder levels per panel class (Samsung media spec); `null` when productinfo is unavailable. */
export function tizenDecoderLevels(): { h264: number; hevc: number } | null {
  const pi = webapis()?.productinfo;
  if (typeof pi?.isUdPanelSupported !== 'function') return null;
  try {
    if (pi.is8KPanelSupported?.()) return { h264: 51, hevc: 183 };
    return pi.isUdPanelSupported() ? { h264: 51, hevc: 153 } : { h264: 42, hevc: 123 };
  } catch {
    return null;
  }
}

/** Demuxers of every Samsung TV listed in the 2015 to 2026 TV Video Specifications (identical in each year); no API lists containers.
 * https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html */
const TIZEN_CONTAINERS = ['mp4', 'mkv', 'mov', 'ts', 'm2ts', 'avi', 'webm'];

/** Codec id to the `isSupportedVideoCodec` enum (Tizen 6.0, 2021 and later). */
const VIDEO_ENUM: Record<string, string> = {
  h264: 'H264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg2video: 'MPEG2',
  mpeg4: 'MPEG4',
  vc1: 'WMV',
};

/** The answer for a codec the firmware cannot be asked about (before Tizen 6.0): HEVC is in every year's spec, H.264 and WebM codecs keep the WebView probe, the rest is not claimed. */
const NO_API_FALLBACK: Record<string, (probed: boolean) => boolean> = {
  h264: (probed) => probed,
  vp8: (probed) => probed,
  vp9: (probed) => probed,
  hevc: () => true,
};

const VIDEO_ALIASES: Record<string, string[]> = {
  h264: ['h264', 'avc1'],
  hevc: ['hevc', 'h265', 'hvc1'],
};

const DEFAULT_CONDITIONS: Record<string, CodecCondition> = {
  hevc: { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 },
  av1: { codec: 'av1', maxBitDepth: 10, profiles: ['main'] },
};

/** What AVPlay decodes, not what the WebView's FHD-only MSE reports: the API answers per codec where the firmware has it, Samsung's published demuxers and decoder levels fill the rest. */
export function tizenVideo(probed: WebVideo): WebVideo {
  const probedCodecs = new Set(probed.videoCodecs);
  const decoded = Object.keys(VIDEO_ENUM).filter((codec) => {
    const asked = isSupported('video', VIDEO_ENUM[codec]);
    return asked ?? NO_API_FALLBACK[codec]?.(probedCodecs.has(codec)) ?? false;
  });
  const videoCodecs = decoded.flatMap((c) => VIDEO_ALIASES[c] ?? [c]);
  const levels = tizenDecoderLevels();
  const codecConditions = decoded.flatMap((codec) => {
    const cond = codec === 'av1' ? DEFAULT_CONDITIONS[codec] : (probed.codecConditions.find((c) => c.codec === codec) ?? DEFAULT_CONDITIONS[codec]);
    if (!cond) return [];
    return [levels && (codec === 'h264' || codec === 'hevc') ? { ...cond, maxLevel: levels[codec] } : cond];
  });
  return { containers: [...new Set([...probed.containers, ...TIZEN_CONTAINERS])], videoCodecs, codecConditions };
}
