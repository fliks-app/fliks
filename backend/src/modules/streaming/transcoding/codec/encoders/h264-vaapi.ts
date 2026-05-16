import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';

/** AMD / Intel-on-Linux VAAPI H.264 encoder. Same code path is used for
 *  both — AMD GPUs talk through Mesa's VAAPI driver, Intel on Linux
 *  falls back to VAAPI when crop forces it (QSV can't crop). Bitrate
 *  passed as the raw profile string (`8M`, `500k`) since VAAPI accepts
 *  the ffmpeg shorthand directly. */
export const h264Vaapi: EncoderDescriptor = {
  id: 'h264_vaapi',
  hwAccel: 'vaapi',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = ['-c:v', 'h264_vaapi', '-b:v', bitrate, '-maxrate', bitrate];
    const trailing = [
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];

    if (filters.tonemapVaapi) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi}`,
        ...trailing,
      ];
    }
    if (filters.tonemapOpencl) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
        ...trailing,
      ];
    }
    return [
      ...common,
      '-vf',
      `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=nv12`,
      ...trailing,
    ];
  },
};
