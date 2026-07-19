import type { EncoderInput } from '../../types';

/** Build the `-vf` value for an 8-bit VAAPI encode (h264 / hevc / av1_vaapi).
 *  All three encoders share this scale/tonemap chain on VAAPI surfaces; only
 *  their codec/profile/tag args differ. Branches:
 *   - `tonemapVaapi`: tonemap on the VAAPI VPP, in place.
 *   - `tonemapOpencl`: OpenCL tonemap, mapped back onto a VAAPI surface.
 *   - default (crop/scale only): `scale_vaapi` → nv12. */
export function vaapiScaleFilter8bit(input: EncoderInput): string {
  const { target, filters } = input;
  const w = target.width;
  if (filters.tonemapVaapi) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi}`;
  }
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`;
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=nv12`;
}

/** Build the `-vf` value for a 10-bit VAAPI HDR encode (hevc/av1 main10). The
 *  surface stays `p010le` with no tonemap — the encoder produces HDR, so the
 *  BT.2020/PQ signalling is preserved. */
export function vaapiScaleFilter10bit(input: EncoderInput): string {
  const { target, filters } = input;
  return `${filters.hwCropPrefix}scale_vaapi=w=${target.width}:h=-2:format=p010le`;
}
