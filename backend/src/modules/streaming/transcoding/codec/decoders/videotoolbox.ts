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
/** ffmpeg defaults to `libdav1d`, which ignores the hwaccel; forcing
 *  `-c:v av1` engages it, and that decoder is hardware-only (fails pre-M3). */
export const av1VideotoolboxDecoder = videotoolboxDecoder('av1', 10, 'av1');
