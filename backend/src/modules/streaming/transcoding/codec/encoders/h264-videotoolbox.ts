import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { scaleMod16Height } from './helpers/scale-filter';

/** Apple VideoToolbox H.264 encoder — Mac 2011+ and all Apple Silicon.
 *  Two paths: full Metal pipeline with `scale_vt` HDR tonemap (no CPU
 *  round-trip) when only tonemap is requested, or CPU buffers + libsw
 *  filters when crop or subtitle burn-in is required (VT decode emits
 *  CPU buffers anyway, so software filters work in place). */
export const h264Videotoolbox: EncoderDescriptor = {
  id: 'h264_videotoolbox',
  hwAccel: 'videotoolbox',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    // CPU tonemap path — see the matching comment in
    // `hevc-videotoolbox.ts`. The `scale_vt` Metal branch is removed
    // because the decoder descriptor outputs CPU buffers (not VT
    // IOSurfaces), and the filter graph can't bridge CPU → vt without
    // `-hwaccel_output_format videotoolbox_vld` upstream. The CPU
    // tonemap chain works on every macOS host.
    return [
      '-c:v',
      'h264_videotoolbox',
      '-profile:v',
      'high',
      ...(early ? ['-realtime', '1'] : []),
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
  },
};
