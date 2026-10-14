import type { LiveSession } from './live-session.service';

/** The decision's bitrates of the rung `s.quality`; null for remux, direct play and an unknown rung. */
export function servedRung(
  s: Pick<LiveSession, 'kind' | 'quality' | 'hdrLadder' | 'bitrateByQuality'>,
) {
  if (
    s.kind !== 'transcode' ||
    typeof s.quality !== 'string' ||
    !s.bitrateByQuality
  )
    return null;
  const hdr =
    s.hdrLadder && !s.quality.endsWith('-hdr') ? `${s.quality}-hdr` : s.quality;
  return s.bitrateByQuality[hdr] ?? s.bitrateByQuality[s.quality] ?? null;
}

/** Video bitrate of the rung a transcode session serves, as the engine capped it. */
export function servedRungBitrate(
  s: Pick<LiveSession, 'kind' | 'quality' | 'hdrLadder' | 'bitrateByQuality'>,
): number | null {
  return servedRung(s)?.videoBitrateBps || null;
}
