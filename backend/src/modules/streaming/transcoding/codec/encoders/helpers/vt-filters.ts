import { DEFAULT_TONEMAP_CURVE, type EncoderInput } from '../../types';
import { dvApplyDoviOpt } from '../../../ffmpeg-filter-graph';
import { scaleEvenHeight } from './scale-filter';

/** Build the `-vf` for the VideoToolbox Metal tone-map path. No crop:
 *  `scale_vt` is RPU-blind, so a no-base source needs `tonemap_videotoolbox`. */
export function vtTonemapFilter(input: EncoderInput): string {
  const { target, filters, dvNoBase, hasCrop } = input;
  const w = target.width;
  const curve = input.tonemapCurve ?? DEFAULT_TONEMAP_CURVE;
  const tm = `tonemap_videotoolbox=tonemap=${curve}:t=bt709:m=bt709:p=bt709:range=tv:${dvApplyDoviOpt(dvNoBase)}`;
  if (hasCrop) {
    return (
      `${tm},hwdownload,format=p010le,${filters.cpuCropPrefix}` +
      `scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p`
    );
  }
  return dvNoBase
    ? `scale_vt=w=${w}:h=-2,${tm}:format=nv12`
    : `scale_vt=w=${w}:h=-2:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709`;
}
