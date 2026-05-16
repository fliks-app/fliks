import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { scaleMod16Height } from './helpers/scale-filter';

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
    const { target, nvencPreset, filters, tonemap, hasCrop } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
      '-c:v', 'h264_nvenc',
      '-preset', nvencPreset,
      '-b:v', bitrate,
      '-maxrate', bitrate,
    ];
    const trailing = [
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
    ];

    if (tonemap) {
      // Download to CPU, tonemap on CPU, encode on NVENC.
      return [
        ...common,
        '-vf',
        `hwdownload,format=p010le,${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}`,
        ...trailing,
      ];
    }
    const nvCropFilter = hasCrop
      ? `hwdownload,format=nv12,${filters.cropStr},hwupload_cuda,`
      : '';
    return [
      ...common,
      '-vf',
      `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=nv12`,
      ...trailing,
    ];
  },
};
