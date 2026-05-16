import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';

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
    const { target, early, filters, tonemap, hasBurnIn, hasCrop } = input;
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

    if (tonemap && !hasBurnIn && !hasCrop) {
      // Full Metal pipeline: scale_vt does HDR→SDR tonemap via the
      // Apple Media Engine. Everything stays on IOSurface — no CPU
      // round-trip.
      return [
        ...common,
        '-vf',
        `scale_vt=w=${w}:h=-2:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709`,
        ...trailing,
      ];
    }
    return [
      ...common,
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:-2:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      ...trailing,
    ];
  },
};
