import type { VideoCodec } from './types';

/** ffprobe codec name → `VideoCodec` union. Aliases (`hvc1`/`hev1` for
 *  HEVC, `avc1`/`avc` for H.264, `av01` for AV1) collapse to the
 *  canonical form. Returns null on unknown codecs so callers can fall
 *  back to CPU decode / efficiency ranking. */
export function normaliseSourceCodec(
  name: string | undefined,
): VideoCodec | null {
  if (!name) return null;
  switch (name.toLowerCase()) {
    case 'h264':
    case 'avc':
    case 'avc1':
      return 'h264';
    case 'hevc':
    case 'h265':
    case 'hvc1':
    case 'hev1':
      return 'hevc';
    case 'av1':
    case 'av01':
      return 'av1';
    default:
      return null;
  }
}
