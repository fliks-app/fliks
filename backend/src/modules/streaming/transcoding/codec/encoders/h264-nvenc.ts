import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { nvencScaleFilter8bit } from './helpers/nvenc-filters';
import { NVENC_GOP_ARGS } from './helpers/nvenc-gop';

/** NVIDIA NVENC H.264 encoder — Kepler and later. Tonemap path round-trips
 *  via CPU (hwdownload + scale + tonemap chain) because the CUDA filter
 *  graph has no native tonemap_cuda equivalent in mainline FFmpeg yet. */
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
