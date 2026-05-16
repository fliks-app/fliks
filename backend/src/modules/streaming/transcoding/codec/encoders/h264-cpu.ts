import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';

/** Universal libx264 fallback. Threads capped at 4 so seg-0 ships
 *  before a long `(threads-1)` frame pre-buffer fills (CPU encoders
 *  with the default thread count add ~half a second of startup
 *  latency to first-frame). `-tune zerolatency` only on early
 *  sessions because steady-state quality suffers. */
export const h264Cpu: EncoderDescriptor = {
  id: 'libx264',
  hwAccel: 'none',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, early, filters, libx264BufsizeMb } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'libx264',
      '-threads:v', '4',
      '-preset', preset,
      ...(early ? ['-tune', 'zerolatency'] : []),
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', libx264BufsizeMb,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:-2:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-force_key_frames', input.forceKeyframesExpr,
      '-sc_threshold:v:0', '0',
    ];
  },
};
