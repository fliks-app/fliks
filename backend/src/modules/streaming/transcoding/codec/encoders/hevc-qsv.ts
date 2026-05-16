import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { qsvScaleFilter8bit } from './helpers/qsv-filters';

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
      '-c:v', 'hevc_qsv',
      '-preset', preset,
      ...qsv.extra,
      '-mbbrc', '1',
      '-b:v', String(target.videoBitrateBps),
      '-maxrate', String(target.videoBitrateBps + 1),
      '-rc_init_occupancy', String(qsv.rcInitOccupancy),
      '-bufsize', String(qsv.bufsize),
      '-vf', qsvScaleFilter8bit(input),
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      '-tag:v', 'hvc1',
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
    const { target, preset, qsv, filters, hasCrop, inputSurface } = input;
    const w = target.width;
    return [
      '-c:v', 'hevc_qsv',
      '-profile:v', 'main10',
      '-preset', preset,
      ...qsv.extra,
      '-mbbrc', '1',
      '-b:v', String(target.videoBitrateBps),
      '-maxrate', String(target.videoBitrateBps + 1),
      '-rc_init_occupancy', String(qsv.rcInitOccupancy),
      '-bufsize', String(qsv.bufsize),
      '-vf',
      hevcQsvHdr10FilterChain({ w, target, filters, hasCrop, inputSurface }),
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
      '-tag:v', 'hvc1',
    ];
  },
};

/** Filter chain for the 10-bit HDR hevc_qsv encode. Two branches:
 *  - `inputSurface='qsv'` (qsv-native decoder, e.g. for HDR + crop):
 *    use `vpp_qsv` which handles crop + scale on the QSV device, p010le
 *    output. Requires explicit integer height — derived from the crop
 *    aspect.
 *  - default (vaapi decoder output): scale_vaapi + hwmap to qsv as
 *    before. */
function hevcQsvHdr10FilterChain(args: {
  w: number;
  target: EncoderInput['target'];
  filters: EncoderInput['filters'];
  hasCrop: boolean;
  inputSurface: EncoderInput['inputSurface'];
}): string {
  const { w, target, filters, hasCrop, inputSurface } = args;
  if (inputSurface === 'qsv') {
    const cropMatch =
      hasCrop && filters.cropStr.match(/^crop=(\d+):(\d+):(\d+):(\d+)$/);
    const cropOpts = cropMatch
      ? `cw=${cropMatch[1]}:ch=${cropMatch[2]}:cx=${cropMatch[3]}:cy=${cropMatch[4]}:`
      : '';
    const targetH = cropMatch
      ? Math.round((w * parseInt(cropMatch[2], 10)) / parseInt(cropMatch[1], 10)) -
        (Math.round((w * parseInt(cropMatch[2], 10)) / parseInt(cropMatch[1], 10)) %
          2)
      : target.height;
    return `vpp_qsv=${cropOpts}w=${w}:h=${targetH}:format=p010le`;
  }
  return `scale_vaapi=w=${w}:h=-16:format=p010le:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
}

/** Same encoder, HLG variant — only difference is the SPS VUI tag. */
export const hevcQsvHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_qsv_hlg',
  hevcQsvHdr10,
);
