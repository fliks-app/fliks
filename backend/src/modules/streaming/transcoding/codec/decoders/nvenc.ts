import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';

/** NVIDIA CUDA decode (paired with NVENC encode on the same device).
 *  `-hwaccel cuda` keeps frames in CUDA surfaces; without
 *  `-hwaccel_output_format cuda` the frames land in CPU memory, which
 *  is what the NVENC tonemap CPU path wants. We always set the output
 *  format here — the tonemap path uses `hwdownload` explicitly when it
 *  needs CPU buffers. */
function cudaDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_cuda_decode`,
    hwAccel: 'nvenc',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'cuda',
    supports: () => true,
    buildInputArgs: () => [
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
      '-noautorotate',
    ],
  };
}

export const h264CudaDecoder = cudaDecoder('h264', 8);
export const hevcCudaDecoder = cudaDecoder('hevc', 10);
export const av1CudaDecoder = cudaDecoder('av1', 10);
