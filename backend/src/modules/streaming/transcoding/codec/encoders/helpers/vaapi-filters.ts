import type { EncoderInput } from '../../types';

/** Build the `-vf` value for an 8-bit VAAPI encode (h264 / hevc / av1_vaapi).
 *  All three encoders share this scale/tonemap chain on VAAPI surfaces; only
 *  their codec/profile/tag args differ. Branches:
 *   - `tonemapVulkan`: libplacebo replaces `scale_vaapi` entirely; it
 *     scales and tonemaps itself, on a Vulkan surface.
 *   - `tonemapVaapi`: tonemap on the VAAPI VPP, in place.
 *   - `tonemapOpencl`: OpenCL tonemap, mapped back onto a VAAPI surface.
 *   - default (crop/scale only): `scale_vaapi` → nv12. */
export function vaapiScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, hasBurnIn } = input;
  const w = target.width;
  // Text burn-in bounces to CPU only for `subtitles=...`, then re-uploads.
  const burnInTail = hasBurnIn
    ? `,hwdownload,format=nv12${filters.burnInFilter},hwupload=derive_device=vaapi:extra_hw_frames=16`
    : '';
  if (filters.tonemapVulkan) {
    return filters.tonemapVulkan;
  }
  if (filters.tonemapVaapi) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi}${burnInTail}`;
  }
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi${burnInTail}`;
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=nv12${burnInTail}`;
}

/** Build the `-vf` value for a 10-bit VAAPI HDR encode (hevc/av1 main10). The
 *  surface stays `p010le` with no tonemap — the encoder produces HDR, so the
 *  BT.2020/PQ signalling is preserved. */
export function vaapiScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, hasBurnIn } = input;
  const burnInTail = hasBurnIn
    ? `,hwdownload,format=p010le${filters.burnInFilter},hwupload=derive_device=vaapi:extra_hw_frames=16`
    : '';
  return `${filters.hwCropPrefix}scale_vaapi=w=${target.width}:h=-2:format=p010le${burnInTail}`;
}
