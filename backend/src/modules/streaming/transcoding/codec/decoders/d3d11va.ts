import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';

/** Windows D3D11VA decode paired with an AMF encode. No
 *  `-hwaccel_output_format`, so FFmpeg downloads the decoded frames to
 *  system memory — the v1 AMF chain scales on CPU then lets `*_amf` upload
 *  and encode. Tagged `hwAccel: 'amf'` so the registry pairs it with the
 *  AMF encoders. Windows-only. */
function d3d11vaDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_d3d11va_decode`,
    hwAccel: 'amf',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'cpu',
    supports: () => process.platform === 'win32',
    buildInputArgs: () => ['-hwaccel', 'd3d11va', '-noautorotate'],
  };
}

export const h264D3d11vaDecoder = d3d11vaDecoder('h264', 8);
export const hevcD3d11vaDecoder = d3d11vaDecoder('hevc', 10);
export const av1D3d11vaDecoder = d3d11vaDecoder('av1', 10);

/** Full-GPU AMF variant: keeps the decoded frame on a D3D11 texture
 *  (`-hwaccel_output_format d3d11`) so `scale_d3d11` + `*_amf` run without a
 *  CPU round-trip. Selected only for the clean SDR path (no crop/tonemap/
 *  burn-in); the CPU-output decoder above stays the baseline. Windows-only. */
function d3d11NativeDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_d3d11va_native_decode`,
    hwAccel: 'amf',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'd3d11',
    supports: () => process.platform === 'win32',
    buildInputArgs: () => [
      '-hwaccel',
      'd3d11va',
      '-hwaccel_output_format',
      'd3d11',
      '-noautorotate',
    ],
  };
}

export const h264D3d11vaNativeDecoder = d3d11NativeDecoder('h264', 8);
export const hevcD3d11vaNativeDecoder = d3d11NativeDecoder('hevc', 10);
export const av1D3d11vaNativeDecoder = d3d11NativeDecoder('av1', 10);

/** Lookup a D3D11-native (full-GPU) decoder by source codec — exposed for
 *  the AMF scale_d3d11 path that bypasses the registry resolver. */
export function findAmfNativeDecoder(
  codec: 'h264' | 'hevc' | 'av1',
): DecoderDescriptor {
  switch (codec) {
    case 'h264':
      return h264D3d11vaNativeDecoder;
    case 'hevc':
      return hevcD3d11vaNativeDecoder;
    case 'av1':
      return av1D3d11vaNativeDecoder;
  }
}
