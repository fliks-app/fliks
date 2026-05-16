import type { EncoderInput } from '../../types';

/** Build the `-vf` value for an 8-bit QSV encode (h264_qsv / hevc_qsv).
 *  Three branches depending on which tonemap the orchestrator wants:
 *
 *  - `tonemapVaapi`  : keep VAAPI surfaces, tonemap on the VPP (1 device).
 *  - `tonemapOpencl` : reinhard via OpenCL, then map to QSV.
 *  - default         : no HDR, plain scale_vaapi → hwmap to QSV.
 *
 *  scale_vaapi is preferred over scale_qsv because libva exposes more
 *  scaling-quality knobs (`extra_hw_frames`, native nv12 output) on
 *  every gen we care about. The hwmap at the tail moves the surfaces
 *  to the QSV device so the encoder consumes them without an implicit
 *  download/upload. */
export function qsvScaleFilter8bit(input: EncoderInput): string {
  const { target, filters } = input;
  const w = target.width;
  if (filters.tonemapVaapi) {
    return `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,format=qsv`;
  }
  if (filters.tonemapOpencl) {
    return `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`;
  }
  return `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
}
