import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { vaapiScaleFilter8bit } from './helpers/vaapi-filters';

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
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'h264_vaapi',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      vaapiScaleFilter8bit(input),
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
  },
};
