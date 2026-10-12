import type { LiveSession } from './live-session.service';
import {
  getHdrLadderForDevice,
  getLadderForDevice,
  hdrRungName,
  parseBitrateToBps,
  resolveLadderRung,
} from './transcoding/profiles';

/** Nominal bitrate of the rung a transcode session serves; null for remux, direct play and an unresolved rung. */
export function servedRungBitrate(
  s: Pick<LiveSession, 'kind' | 'quality' | 'hdrLadder' | 'deviceType'>,
): number | null {
  if (s.kind !== 'transcode' || !s.quality) return null;
  const ladder = s.hdrLadder
    ? getHdrLadderForDevice(s.deviceType)
    : getLadderForDevice(s.deviceType);
  const rung = resolveLadderRung(hdrRungName(s.quality, s.hdrLadder), ladder);
  return rung ? parseBitrateToBps(rung.videoBitrate) || null : null;
}
