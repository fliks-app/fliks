import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString } from '../codec-strings';

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
      `scale_vaapi=w=${w}:h=-16:format=p010le:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      '-color_primaries', 'bt2020',
      '-color_trc', 'smpte2084',
      '-colorspace', 'bt2020nc',
      '-tag:v', 'hvc1',
    ];
  },
};

/** Same encoder, HLG variant — only difference is the SPS VUI tag. */
export const hevcQsvHlg: EncoderDescriptor = {
  id: 'hevc_qsv_hlg',
  hwAccel: 'qsv',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HLG' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const args = hevcQsvHdr10.buildArgs(input);
    const tIdx = args.indexOf('-color_trc');
    if (tIdx !== -1) args[tIdx + 1] = 'arib-std-b67';
    return args;
  },
};
