import type { EncoderInput } from '../../types';
import { scaleEvenHeight } from './scale-filter';

/** `-vf` for an 8-bit AMF encode. The v1 AMF chain runs on CPU surfaces
 *  (d3d11va decode auto-downloads); `*_amf` uploads and encodes the scaled
 *  frames. Any non-CPU surface is pulled down first. */
export function amfScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, inputSurface } = input;
  const w = target.width;
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
  const { target, filters, inputSurface } = input;
  const w = target.width;
  const download =
    inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
  return `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le`;
}
