import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { qsvScaleFilter8bit, qsvScaleFilter10bit } from './helpers/qsv-filters';

/** Intel QSV AV1 encoder — Arc (DG2) and Meteor Lake iGPU and above on
 *  Linux 6.2+. Same VAAPI-decode → scale_vaapi → hwmap-to-qsv chain as
 *  h264_qsv; only the encoder name, pixel format and CODECS string
 *  differ. SDR path uses nv12 throughout. */
export const av1Qsv: EncoderDescriptor = {
  id: 'av1_qsv',
  hwAccel: 'qsv',
  variant: { codec: 'av1', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 8),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, qsv } = input;
    return [
      '-c:v',
      'av1_qsv',
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

/** Intel QSV AV1 HDR10 — same pipeline in p010le. `supportsHdrMetadata`
 *  is false: media-driver issue 1592 — `av1_qsv` has no mastering-display
 *  API, so the mdcv/clli SEI never reaches the bitstream. Registry routes
 *  HDR variants to the libsvtav1 fallback instead. Color tags are kept
 *  here for completeness in case the encoder ever gains the API. */
export const av1QsvHdr10: EncoderDescriptor = {
  id: 'av1_qsv_hdr10',
  hwAccel: 'qsv',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, qsv } = input;
    return [
      '-c:v',
      'av1_qsv',
      '-pix_fmt',
      'p010le',
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
      qsvScaleFilter10bit(input),
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
    ];
  },
};
