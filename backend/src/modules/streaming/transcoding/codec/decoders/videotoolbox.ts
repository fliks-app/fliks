import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';

/** Apple VideoToolbox decode. Output surface is treated as `'cpu'`:
 *  VT can emit IOSurfaces (videotoolbox_vld) for the full Metal
 *  pipeline, but every consuming filter we ship today (subtitle burn-
 *  in, software scale, libass) operates on CPU buffers. The encoder
 *  side (`hevc_videotoolbox` etc.) is happy ingesting CPU input too,
 *  so keeping the surface at `'cpu'` matches the existing behaviour
 *  while removing the hwAccel branching from ffmpeg-args. */
function videotoolboxDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
  forceDecoder?: string,
): DecoderDescriptor {
  return {
    id: `${codec}_videotoolbox_decode`,
    hwAccel: 'videotoolbox',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'cpu',
    supports: () => process.platform === 'darwin',
    buildInputArgs: () => [
      '-hwaccel',
      'videotoolbox',
      ...(forceDecoder ? ['-c:v', forceDecoder] : []),
      '-noautorotate',
    ],
  };
}

export const h264VideotoolboxDecoder = videotoolboxDecoder('h264', 8);
export const hevcVideotoolboxDecoder = videotoolboxDecoder('hevc', 10);
/** ffmpeg's default AV1 decoder pick is `libdav1d`, which ignores
 *  `-hwaccel videotoolbox` silently and decodes on the CPU. Forcing the
 *  native `av1` decoder engages the hwaccel; that decoder has no software
 *  path, so it hard-fails on Macs without AV1 hardware (pre-M3) instead of
 *  degrading quietly; the probe below turns that into a disabled descriptor. */
export const av1VideotoolboxDecoder = videotoolboxDecoder('av1', 10, 'av1');
