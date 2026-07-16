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
