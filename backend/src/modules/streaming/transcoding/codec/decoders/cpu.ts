import type { DecoderDescriptor } from './types';

/** Software decode. ffmpeg picks the right `libavcodec` decoder from the
 *  source codec automatically — we don't pass `-c:v` because that's the
 *  decoder's job, and ffmpeg's default selection (e.g. h264 → libavcodec
 *  h264, hevc → hevc, av1 → libdav1d when built in) is what we want.
 *  No HW device init means no `-hwaccel` flag — frames land in main
 *  memory as the codec's native output (yuv420p, yuv420p10le, etc.). */
export const cpuDecoder: DecoderDescriptor = {
  id: 'cpu',
  hwAccel: 'none',
  sourceCodec: 'any',
  maxBitDepth: 10,
  outputSurface: 'cpu',
  supports: () => true,
  buildInputArgs: () => [],
};
