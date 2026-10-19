/** Samsung's `webapis.systeminfo` codec API: synchronous and answers for the AVPlay decoders, unlike the WebView's MSE probe; containers have no equivalent.
 * https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/systeminfo-api.html */

interface TizenSystemInfo {
  isSupportedAudioCodec?(codec: string): boolean;
  isSupportedVideoCodec?(codec: string): boolean;
}

/** Fliks codec id to Samsung enum, for codecs the backend can copy into HLS; absent ones (flac, alac, mp3) keep the MSE probe answer. */
const AUDIO_ENUM: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC3',
  eac3: 'E-AC3',
  opus: 'OPUS',
};

function systemInfo(): TizenSystemInfo | null {
  const w = window as unknown as { webapis?: { systeminfo?: TizenSystemInfo } };
  return w.webapis?.systeminfo ?? null;
}

/** `null` when the firmware doesn't expose the call, so callers keep their
 *  existing answer instead of treating a missing API as "unsupported". */
function isSupported(kind: 'audio' | 'video', name: string): boolean | null {
  const si = systemInfo();
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
  const merged = probed.filter((c) => !(c in AUDIO_ENUM));
  let answered = false;
  for (const [codec, samsungName] of Object.entries(AUDIO_ENUM)) {
    const supported = isSupported('audio', samsungName);
    if (supported === null) {
      if (probed.includes(codec)) merged.push(codec);
      continue;
    }
    answered = true;
    if (supported) merged.push(codec);
  }
  return answered ? merged : probed;
}

/** Whether AVPlay decodes HEVC. `null` keeps the caller's assumption. */
export function tizenSupportsHevc(): boolean | null {
  return isSupported('video', 'HEVC');
}
