import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { masterDisplayString, maxCllString } from './helpers/hdr-metadata';
import { qsvScaleFilter8bit, qsvScaleFilter10bit } from './helpers/qsv-filters';

/** Intel QSV HEVC Main 8-bit encoder — Skylake gen6 and above. Native
 *  HW path for HEVC SDR sources; avoids the libx265 CPU round-trip the
 *  registry would otherwise pick as fallback when this descriptor is
 *  absent. Same VAAPI-decode → scale_vaapi → hwmap → hevc_qsv chain
 *  as h264_qsv, only the encoder and codec string differ. */
export const hevcQsv: EncoderDescriptor = {
  id: 'hevc_qsv',
  hwAccel: 'qsv',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, qsv } = input;
    // Tonemap dispatch is shared with h264_qsv — same VAAPI surfaces,
    // same VAAPI/OpenCL tonemap kernels, same hwmap to QSV at the
    // tail. Without it an HDR source decoded to this SDR descriptor
    // would arrive at the encoder as nv12 pixels still carrying PQ
    // luminance and the BT.709 SPS tags downstream would render
    // washed-out greys.
    return [
      '-c:v',
      'hevc_qsv',
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
      '-tag:v',
      'hvc1',
    ];
  },
};

/** Intel QSV HEVC Main10 encoder — Kaby Lake gen7 and above. The only
 *  HW HEVC path with reliable HDR10 / HLG metadata propagation on
 *  mainline FFmpeg. Color tags come from the input AVFrame; the
 *  `-color_*` flags here are belt-and-suspenders for encoder builds
 *  that ignore AVFrame metadata. */
export const hevcQsvHdr10: EncoderDescriptor = {
  id: 'hevc_qsv_main10',
  hwAccel: 'qsv',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, qsv } = input;
    return [
      '-c:v',
      'hevc_qsv',
      '-profile:v',
      'main10',
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
      // Emit the probed source mastering-display / content-light SEI explicitly
      // when available, rather than relying solely on AVFrame metadata
      // propagation through the QSV filter chain. Absent → input-derived (#354).
      ...(input.hdrMetadata
        ? [
            '-master_display',
            masterDisplayString(input.hdrMetadata),
            '-max_cll',
            maxCllString(input.hdrMetadata),
          ]
        : []),
      '-tag:v',
      'hvc1',
    ];
  },
};

/** Same encoder, HLG variant — only difference is the SPS VUI tag. */
export const hevcQsvHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_qsv_hlg',
  hevcQsvHdr10,
);
