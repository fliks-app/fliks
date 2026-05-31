import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { scaleEvenHeight } from './helpers/scale-filter';

/** Universal libx264 fallback. Threads capped at 4 so seg-0 ships
 *  before a long `(threads-1)` frame pre-buffer fills (CPU encoders
 *  with the default thread count add ~half a second of startup
 *  latency to first-frame).
 *
 *  Preset is pinned to `veryfast` and `-tune zerolatency` is *not*
 *  used. The early-warm session writes init.mp4 at the same time as
 *  the steady-state session; the controller serves init.mp4 from
 *  one of them and segments from the other, so the two pipelines
 *  must produce identical SPS. libx264 bakes preset-dependent
 *  knobs (`ref`, `bframes`, `weightp`, …) into the SPS, and any
 *  difference between sessions trips the decoder ("QP out of range"
 *  / "decode_slice_header error"). The QSV path is immune — its
 *  SPS only encodes profile/level — but on libx264 we have to hold
 *  the encoder configuration identical across sessions. */
export const h264Cpu: EncoderDescriptor = {
  id: 'libx264',
  hwAccel: 'none',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters, libx264BufsizeMb } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'libx264',
      '-threads:v',
      '4',
      '-preset',
      'veryfast',
      '-profile:v',
      'high',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-bufsize',
      libx264BufsizeMb,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-sc_threshold:v:0',
      '0',
    ];
  },
};
