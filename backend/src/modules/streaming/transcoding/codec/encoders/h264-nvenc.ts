import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { nvencScaleFilter8bit } from './helpers/nvenc-filters';
import { NVENC_GOP_ARGS } from './helpers/nvenc-gop';

/** NVIDIA NVENC H.264 encoder, Kepler and later. Tone-maps via `tonemap_cuda`
 *  (GPU, zero-copy) when probed, else the CPU/OpenCL bounce chain. */
export const h264Nvenc: EncoderDescriptor = {
  id: 'h264_nvenc',
  hwAccel: 'nvenc',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'h264_nvenc',
      '-preset',
      nvencPreset,
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      nvencScaleFilter8bit(input),
      ...NVENC_GOP_ARGS,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
  },
};
