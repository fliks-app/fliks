import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';

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
    const { target, preset, qsv, filters, tonemap } = input;
    const w = target.width;
    const common = [
      '-c:v', 'h264_qsv',
      '-preset', preset,
      ...qsv.extra,
      '-mbbrc', '1',
      '-b:v', String(target.videoBitrateBps),
      '-maxrate', String(target.videoBitrateBps + 1),
      '-rc_init_occupancy', String(qsv.rcInitOccupancy),
      '-bufsize', String(qsv.bufsize),
    ];
    const trailing = [
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
    ];

    if (filters.tonemapVaapi) {
      // VAAPI decode → VAAPI scale → VAAPI tonemap → QSV encode (1 device)
      return [
        ...common,
        '-vf',
        `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,format=qsv`,
        ...trailing,
      ];
    }
    if (filters.tonemapOpencl) {
      // VAAPI decode → VAAPI scale → OpenCL tonemap → map to QSV → QSV encode
      return [
        ...common,
        '-vf',
        `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`,
        ...trailing,
      ];
    }
    // Suppress unused warning when tonemap was requested but no filter is
    // active (shouldn't normally happen — orchestrator guards).
    void tonemap;
    return [
      ...common,
      '-vf',
      `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
      ...trailing,
    ];
  },
};
