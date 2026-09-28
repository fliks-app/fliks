import type { EncoderInput } from '../../types';
import { scaleEvenHeight } from './scale-filter';
import { dvApplyDoviOpt } from '../../../ffmpeg-filter-graph';

/** Whether the AMF `-vf` chain below lands on a D3D11 surface rather than CPU
 *  frames. Shared with the PGS burn-in composite (`hwdownload` before compositing). */
export const amfVfEndsOnGpu = (i: EncoderInput): boolean =>
  i.inputSurface === 'd3d11';

/** Zero-copy AMF chain: hwmap to OpenCL, scale (+ crop, + tonemap for HDR),
 *  hwmap back to D3D11. `reset_sar=1` fixes the SAR a hardware crop leaves wrong. */
function amfOpenclFilter(
  input: EncoderInput,
  outputFormat: 'nv12' | 'p010le',
): string {
  const { target, filters, tonemap, tonemapCurve, dvNoBase } = input;
  const w = target.width;
  const curve = tonemapCurve ?? 'hable';
  const crop = filters.cropStr ? `${filters.cropStr},` : '';
  const scale = `scale_opencl=w=${w}:h=${target.height}:reset_sar=1`;
  // Tonemap: format left unset (p010 passthrough), tonemap_opencl sets it.
  const step = tonemap
    ? `${scale},tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)}`
    : `${scale}:format=${outputFormat}`;
  return `hwmap=derive_device=opencl:mode=read,${crop}${step},hwmap=derive_device=d3d11va:mode=write:reverse=1,format=d3d11`;
}

/** `-vf` for an 8-bit AMF encode. Zero-copy OpenCL on a D3D11 surface when
 *  `amfOpenclPath`; otherwise frames are pulled down and scaled on the CPU. */
export function amfScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, inputSurface, amfOpenclPath } = input;
  const w = target.width;
  if (inputSurface === 'd3d11' && amfOpenclPath) {
    return amfOpenclFilter(input, 'nv12');
  }
  const download =
    inputSurface === 'cpu'
      ? ''
      : tonemap
        ? 'hwdownload,format=p010le,'
        : 'hwdownload,format=nv12,';
  const tm = tonemap ? filters.tonemapCpu : '';
  return `${download}${filters.cpuCropPrefix}${tm}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=nv12`;
}

/** `-vf` for a 10-bit AMF HDR encode. No tonemap branch — a 10-bit encoder
 *  preserves HDR; tonemap-to-SDR sources are routed to the 8-bit rung. */
export function amfScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, inputSurface, amfOpenclPath } = input;
  const w = target.width;
  if (inputSurface === 'd3d11' && amfOpenclPath) {
    return amfOpenclFilter(input, 'p010le');
  }
  const download =
    inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
  return `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le`;
}
