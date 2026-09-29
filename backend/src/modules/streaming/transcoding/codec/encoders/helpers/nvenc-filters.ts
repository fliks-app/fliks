import type { EncoderInput } from '../../types';
import { scaleEvenHeight } from './scale-filter';

/** Whether the NVENC `-vf` chain below lands on a CUDA surface rather than
 *  CPU frames. Shared with the PGS burn-in composite, which needs to know
 *  whether to `hwdownload` before compositing. */
export const nvencVfEndsOnGpu = (i: EncoderInput): boolean =>
  i.tonemap ? !!i.filters.tonemapCuda : i.inputSurface === 'cuda';

/** Build the `-vf` value for an NVENC encode at the given bit depth. `'cuda'`
 *  input stays on the device; other surfaces bounce through `hwdownload`/`hwupload_cuda`. */
function nvencScaleFilter(input: EncoderInput, bitDepth: 8 | 10): string {
  const { target, filters, tonemap, hasCrop, hasBurnIn, inputSurface } = input;
  const w = target.width;
  const fmt = bitDepth === 8 ? 'nv12' : 'p010le';
  const swFmt = bitDepth === 8 ? 'yuv420p' : 'p010le';
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
      ? `hwdownload,format=${fmt},${filters.cropStr},hwupload_cuda,`
      : '';
    // Explicit format: a 10-bit source decodes to p010le even on the 8-bit rung.
    vf = `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=${fmt}`;
  } else {
    const download = inputSurface === 'cpu' ? '' : `hwdownload,format=${fmt},`;
    vf = `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=${swFmt}`;
  }
  // Text burn-in needs CPU buffers for libass: bounce down only if the chain
  // is still on a CUDA surface, keeping NVDEC + the tone-map on the GPU.
  return hasBurnIn
    ? `${vf}${nvencVfEndsOnGpu(input) ? `,hwdownload,format=${fmt}` : ''}${filters.burnInFilter}`
    : vf;
}

export const nvencScaleFilter8bit = (input: EncoderInput): string =>
  nvencScaleFilter(input, 8);

export const nvencScaleFilter10bit = (input: EncoderInput): string =>
  nvencScaleFilter(input, 10);
