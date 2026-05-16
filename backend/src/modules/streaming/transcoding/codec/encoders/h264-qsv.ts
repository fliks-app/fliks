import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { qsvScaleFilter8bit } from './helpers/qsv-filters';

/** Intel QSV H.264 encoder — Skylake gen6 and above. Three filter chains
 *  depending on tonemap availability: VAAPI-native tonemap (cheapest,
 *  used on early sessions), OpenCL tonemap (better quality, steady-state
 *  HDR→SDR), or plain (no tonemap). */
export const h264Qsv: EncoderDescriptor = {
  id: 'h264_qsv',
  hwAccel: 'qsv',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, qsv } = input;
    return [
      '-c:v',
      'h264_qsv',
      '-preset',
      preset,
      ...qsv.extra,
      '-mbbrc',
      '1',
      '-b:v',
      String(target.videoBitrateBps),
      '-maxrate',
      String(target.videoBitrateBps + 1),
      '-rc_init_occupancy',
      String(qsv.rcInitOccupancy),
      '-bufsize',
      String(qsv.bufsize),
      '-vf',
      qsvScaleFilter8bit(input),
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
  },
};
