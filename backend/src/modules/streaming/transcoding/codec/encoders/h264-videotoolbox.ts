import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { scaleEvenHeight } from './helpers/scale-filter';
import { vtTonemapFilter } from './helpers/vt-filters';

/** Apple VideoToolbox H.264 encoder — Mac 2011+ and all Apple Silicon.
 *  Tone-maps on the Metal surface when eligible, else falls back to CPU. */
export const h264Videotoolbox: EncoderDescriptor = {
  id: 'h264_videotoolbox',
  hwAccel: 'videotoolbox',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters, inputSurface } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
      '-c:v',
      'h264_videotoolbox',
      '-profile:v',
      'high',
      ...(early ? ['-realtime', '1'] : []),
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
    ];
    const trailing = [
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
    // Metal fast path; see `hevc-videotoolbox.ts` for the surface rules.
    if (inputSurface === 'videotoolbox') {
      return [...common, '-vf', vtTonemapFilter(input), ...trailing];
    }
    return [
      ...common,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      ...trailing,
    ];
  },
};
