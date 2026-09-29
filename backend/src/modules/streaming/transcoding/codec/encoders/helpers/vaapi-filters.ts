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

/** Build the `-vf` value for a 10-bit VAAPI HDR encode (hevc/av1 main10). No
 *  tonemap normally; the encoder produces HDR, so BT.2020/PQ is preserved
 *  as-is. `tonemapOpencl` is the one exception: a no-base DV source reshaped
 *  into HDR10 still needs the RPU-aware OpenCL bounce (see dvNoBaseHdr10Eligible). */
export function vaapiScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, hasBurnIn, tonemap } = input;
  const w = target.width;
  const burnInTail = hasBurnIn
    ? `,hwdownload,format=p010le${filters.burnInFilter},hwupload=derive_device=vaapi:extra_hw_frames=16`
    : '';
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi${burnInTail}`;
  }
  // No other tonemap step exists at 10-bit: shipping the plain scale here
  // would tag raw HDR pixels with whatever the caller intended as output.
  if (tonemap) {
    throw new Error('vaapiScaleFilter10bit: tonemap requested with no opencl chain');
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=p010le${burnInTail}`;
}
