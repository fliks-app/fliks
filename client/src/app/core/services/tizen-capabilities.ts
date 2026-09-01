/**
 * Samsung's codec-capability API, the only runtime capability source on Tizen.
 *
 * `webapis.systeminfo.isSupported{Audio,Video}Codec(name)` is synchronous and
 * answers for the AVPlay decoders that actually play the stream, unlike the
 * WebView's `MediaSource.isTypeSupported` (which speaks for a Chromium 85 MSE
 * pipeline we never use on this platform). Containers have no equivalent API,
 * so they stay declared from the media specifications.
 *
 * https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/systeminfo-api.html
 */

interface TizenSystemInfo {
  isSupportedAudioCodec?(codec: string): boolean;
  isSupportedVideoCodec?(codec: string): boolean;
}

/** Fliks codec id → Samsung enum name, for the codecs the API enumerates and
 *  the backend can copy into an HLS segment. Codecs absent here (flac, alac,
 *  mp3) have no enum and keep whatever the MSE probe answered. */
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

/**
 * Merge the MSE-probed audio codec list with what AVPlay really decodes: the
 * API decides every codec it enumerates, the rest pass through untouched.
 * Returns the input unchanged when the API is unavailable.
 */
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
