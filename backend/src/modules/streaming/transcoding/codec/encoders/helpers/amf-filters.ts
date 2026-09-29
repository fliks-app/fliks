import {
  DEFAULT_TONEMAP_CURVE,
  type EncoderInput,
  type TonemapCurve,
} from '../../types';
import { scaleEvenHeight } from './scale-filter';
import { tonemapOpenclOpts } from '../../../ffmpeg-filter-graph';

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
  const curve = tonemapCurve ?? DEFAULT_TONEMAP_CURVE;
  const crop = cropStr ? `${cropStr},` : '';
  // reset_sar=1 only matters after a crop: it fixes the SAR the crop leaves
  // wrong; on an uncropped anamorphic source it would squash the picture.
  const resetSar = cropStr ? ':reset_sar=1' : '';
  const scale = `scale_opencl=w=${width}:h=${height}${resetSar}`;
  // outputFormat === 'p010le' only happens on the HDR10 descriptor, and a
  // tonemap there is always a no-base DV reshape (see dvNoBaseHdr10Eligible).
  const step = tonemap
    ? `${scale},tonemap_opencl=${tonemapOpenclOpts({ hdr10Target: outputFormat === 'p010le', curve, dvNoBase })}`
    : `${scale}:format=${outputFormat}`;
  // Text burn-in: hwdownload straight off OpenCL, hand AMF CPU frames directly.
  // Its encoder takes nv12/p010le natively, no re-upload to d3d11 needed.
  if (burnInFilter) {
    return `hwmap=derive_device=opencl:mode=read,${crop}${step},hwdownload,format=${outputFormat}${burnInFilter}`;
  }
  return `hwmap=derive_device=opencl:mode=read,${crop}${step},hwmap=derive_device=d3d11va:mode=write:reverse=1,format=d3d11`;
}

/** `-vf` for an AMF encode at the given bit depth. A D3D11 surface only ever
 *  comes from the zero-copy decoder (see `isAmfOpenclPath`); otherwise frames
 *  are pulled down and scaled on the CPU. */
function amfScaleFilter(input: EncoderInput, bitDepth: 8 | 10): string {
  const { target, filters, tonemap, tonemapCurve, dvNoBase, inputSurface, hasBurnIn } =
    input;
  const w = target.width;
  const fmt = bitDepth === 8 ? 'nv12' : 'p010le';
  if (inputSurface === 'd3d11') {
    return amfOpenclFilter({
      width: w,
      height: target.height,
      cropStr: filters.cropStr,
      tonemap,
      tonemapCurve,
      dvNoBase,
      outputFormat: fmt,
      burnInFilter: hasBurnIn ? filters.burnInFilter : undefined,
    });
  }
  // 10-bit downloads always need p010le precision; 8-bit only needs it ahead of a tonemap.
  const download =
    inputSurface === 'cpu'
      ? ''
      : bitDepth === 10 || tonemap
        ? 'hwdownload,format=p010le,'
        : 'hwdownload,format=nv12,';
  const tm = tonemap ? filters.tonemapCpu : '';
  return `${download}${filters.cpuCropPrefix}${tm}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=${fmt}${filters.burnInFilter}`;
}

export const amfScaleFilter8bit = (input: EncoderInput): string =>
  amfScaleFilter(input, 8);

export const amfScaleFilter10bit = (input: EncoderInput): string =>
  amfScaleFilter(input, 10);
