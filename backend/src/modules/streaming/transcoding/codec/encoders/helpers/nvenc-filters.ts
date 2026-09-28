import type { EncoderInput } from '../../types';
import { scaleEvenHeight } from './scale-filter';

/** Whether the NVENC `-vf` chain below lands on a CUDA surface rather than
 *  CPU frames. Shared with the PGS burn-in composite, which needs to know
 *  whether to `hwdownload` before compositing. */
export const nvencVfEndsOnGpu = (i: EncoderInput): boolean =>
  i.tonemap ? !!i.filters.tonemapCuda : i.inputSurface === 'cuda';

/** Build the `-vf` value for an 8-bit NVENC SDR encode. `'cuda'` input stays
 *  on the device; other surfaces bounce through `hwdownload`/`hwupload_cuda`. */
export function nvencScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, hasCrop, hasBurnIn, inputSurface } = input;
  const w = target.width;
  let vf: string;
  if (tonemap && filters.tonemapCuda) {
    // Already on a CUDA surface with no crop: nothing to bounce.
    const crop = filters.cpuCropPrefix;
    const upload =
      inputSurface === 'cuda' && !hasCrop
        ? ''
        : inputSurface === 'cpu'
          ? `${crop}format=p010le,hwupload_cuda,`
          : `hwdownload,format=p010le,${crop}hwupload_cuda,`;
    vf = `${upload}scale_cuda=w=${w}:h=-2:format=p010le${filters.tonemapCuda}`;
  } else if (tonemap) {
    // tonemapCpu already emits `format=yuv420p`; only the download prefix
    // differs. Tonemap implies a 10-bit HDR source, so download as p010le.
    const download =
      inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
    vf = `${download}${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}`;
  } else if (inputSurface === 'cuda') {
    const nvCropFilter = hasCrop
      ? `hwdownload,format=nv12,${filters.cropStr},hwupload_cuda,`
      : '';
    // Explicit nv12: a 10-bit source decodes to p010le even for this 8-bit
    // rung, and scale_cuda otherwise keeps that native format untouched.
    vf = `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=nv12`;
  } else {
    const download = inputSurface === 'cpu' ? '' : 'hwdownload,format=nv12,';
    vf = `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p`;
  }
  // Text burn-in needs CPU buffers for libass: bounce down only if the chain
  // is still on a CUDA surface, keeping NVDEC + the tone-map on the GPU.
  return hasBurnIn
    ? `${vf}${nvencVfEndsOnGpu(input) ? ',hwdownload,format=nv12' : ''}${filters.burnInFilter}`
    : vf;
}

/** Build the `-vf` value for a 10-bit NVENC HDR encode (hevc_nvenc
 *  main10, av1_nvenc hdr10 / hlg). Same surface split as the 8-bit path,
 *  but the pixels stay `p010le` end-to-end — there is no tonemap branch
 *  because a 10-bit HDR encoder is preserving HDR (tonemapping it would
 *  defeat the bitstream's HDR signaling; tonemap-to-SDR sources are routed
 *  to the 8-bit SDR rung by the registry).
 */
export function nvencScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, hasCrop, hasBurnIn, inputSurface } = input;
  const w = target.width;
  let vf: string;
  if (inputSurface === 'cuda') {
    const nvCropFilter = hasCrop
      ? `hwdownload,format=p010le,${filters.cropStr},hwupload_cuda,`
      : '';
    vf = `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=p010le`;
  } else {
    const download = inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
    vf = `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le`;
  }
  return hasBurnIn
    ? `${vf}${nvencVfEndsOnGpu(input) ? ',hwdownload,format=p010le' : ''}${filters.burnInFilter}`
    : vf;
}
