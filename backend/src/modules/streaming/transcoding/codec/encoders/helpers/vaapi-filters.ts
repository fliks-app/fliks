import type { EncoderInput } from '../../types';

/** Build the `-vf` value for a VAAPI encode at the given bit depth.
 *  `tonemapVulkan`/`tonemapVaapi` only apply at 8-bit; 10-bit throws on an unhandled tonemap. */
function vaapiScaleFilter(input: EncoderInput, bitDepth: 8 | 10): string {
  const { target, filters, hasBurnIn, tonemap } = input;
  const w = target.width;
  const fmt = bitDepth === 8 ? 'nv12' : 'p010le';
  // Text burn-in bounces to CPU only for `subtitles=...`, then re-uploads.
  const burnInTail = hasBurnIn
    ? `,hwdownload,format=${fmt}${filters.burnInFilter},hwupload=derive_device=vaapi:extra_hw_frames=16`
    : '';
  if (bitDepth === 8 && filters.tonemapVulkan) {
    return filters.tonemapVulkan;
  }
  if (bitDepth === 8 && filters.tonemapVaapi) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi}${burnInTail}`;
  }
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi${burnInTail}`;
  }
  if (bitDepth === 10 && tonemap) {
    throw new Error('vaapiScaleFilter10bit: tonemap requested with no opencl chain');
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=${fmt}${burnInTail}`;
}

export const vaapiScaleFilter8bit = (input: EncoderInput): string =>
  vaapiScaleFilter(input, 8);

export const vaapiScaleFilter10bit = (input: EncoderInput): string =>
  vaapiScaleFilter(input, 10);
