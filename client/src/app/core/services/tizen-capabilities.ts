/** Samsung's `webapis.systeminfo` codec API: synchronous and answers for the AVPlay decoders, unlike the WebView's MSE probe; containers have no equivalent.
 * https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/systeminfo-api.html */

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

/** Whether AVPlay decodes this video codec (Samsung enum name). `null` keeps the caller's assumption. */
export function tizenSupportsVideoCodec(name: 'HEVC' | 'AV1'): boolean | null {
  return isSupported('video', name);
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
