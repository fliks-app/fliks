import type { EncoderInput, TonemapCurve } from '../../types';
import { scaleEvenHeight } from './scale-filter';
import { dvApplyDoviOpt } from '../../../ffmpeg-filter-graph';

/** Whether the AMF `-vf` chain below lands on a D3D11 surface rather than CPU
 *  frames. Shared with the PGS burn-in composite (`hwdownload` before compositing). */
export const amfVfEndsOnGpu = (i: EncoderInput): boolean =>
  i.inputSurface === 'd3d11' && !i.hasBurnIn;

/** Zero-copy AMF chain: hwmap to OpenCL, scale (+ crop, + tonemap for HDR),
 *  hwmap back to D3D11. Small params object (not `EncoderInput`) so the boot
 *  probe can build the same `-vf` a real session would, with no fake session. */
export function amfOpenclFilter(opts: {
  width: number;
  height: number;
  cropStr: string;
  tonemap: boolean;
  tonemapCurve?: TonemapCurve;
  dvNoBase?: boolean;
  outputFormat: 'nv12' | 'p010le';
  /** Text burn-in tail (`,subtitles=...`), already comma-prefixed or empty. */
  burnInFilter?: string;
}): string {
  const {
    width,
    height,
    cropStr,
    tonemap,
    tonemapCurve,
    dvNoBase,
    outputFormat,
    burnInFilter,
  } = opts;
  const curve = tonemapCurve ?? 'hable';
  const crop = cropStr ? `${cropStr},` : '';
  // reset_sar=1 only matters after a crop: it fixes the SAR the crop leaves
  // wrong; on an uncropped anamorphic source it would squash the picture.
  const resetSar = cropStr ? ':reset_sar=1' : '';
  const scale = `scale_opencl=w=${width}:h=${height}${resetSar}`;
  // Tonemap: format left unset (p010 passthrough), tonemap_opencl sets it.
  // outputFormat === 'p010le' only happens on the HDR10 descriptor, and a
  // tonemap there is always a no-base DV reshape (see dvNoBaseHdr10Eligible).
  const step = tonemap
    ? outputFormat === 'p010le'
      ? `${scale},tonemap_opencl=format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:${dvApplyDoviOpt(dvNoBase)}`
      : `${scale},tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)}`
    : `${scale}:format=${outputFormat}`;
  // Text burn-in: hwdownload straight off OpenCL, hand AMF CPU frames directly.
  // Its encoder takes nv12/p010le natively, no re-upload to d3d11 needed.
  if (burnInFilter) {
    return `hwmap=derive_device=opencl:mode=read,${crop}${step},hwdownload,format=${outputFormat}${burnInFilter}`;
  }
  return `hwmap=derive_device=opencl:mode=read,${crop}${step},hwmap=derive_device=d3d11va:mode=write:reverse=1,format=d3d11`;
}

/** `-vf` for an 8-bit AMF encode. A D3D11 surface only ever comes from the
 *  zero-copy decoder (see `isAmfOpenclPath`); otherwise frames are pulled
 *  down and scaled on the CPU. */
export function amfScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, tonemapCurve, dvNoBase, inputSurface, hasBurnIn } =
    input;
  const w = target.width;
  if (inputSurface === 'd3d11') {
    return amfOpenclFilter({
      width: w,
      height: target.height,
      cropStr: filters.cropStr,
      tonemap,
      tonemapCurve,
      dvNoBase,
      outputFormat: 'nv12',
      burnInFilter: hasBurnIn ? filters.burnInFilter : undefined,
    });
  }
  const download =
    inputSurface === 'cpu'
      ? ''
      : tonemap
        ? 'hwdownload,format=p010le,'
        : 'hwdownload,format=nv12,';
  const tm = tonemap ? filters.tonemapCpu : '';
  return `${download}${filters.cpuCropPrefix}${tm}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=nv12${filters.burnInFilter}`;
}

/** `-vf` for a 10-bit AMF HDR encode. Normally no tonemap; a 10-bit
 *  encoder preserves HDR; tonemap-to-SDR sources are routed to the 8-bit
 *  rung. The exception is a no-base DV source reshaped into HDR10 (see
 *  dvNoBaseHdr10Eligible), which still needs the RPU-aware OpenCL bounce. */
export function amfScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, tonemap, tonemapCurve, dvNoBase, inputSurface, hasBurnIn } =
    input;
  const w = target.width;
  if (inputSurface === 'd3d11') {
    return amfOpenclFilter({
      width: w,
      height: target.height,
      cropStr: filters.cropStr,
      tonemap,
      tonemapCurve,
      dvNoBase,
      outputFormat: 'p010le',
      burnInFilter: hasBurnIn ? filters.burnInFilter : undefined,
    });
  }
  const download =
    inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
  const tm = tonemap ? filters.tonemapCpu : '';
  return `${download}${filters.cpuCropPrefix}${tm}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le${filters.burnInFilter}`;
}
