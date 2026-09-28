import {
  h264VideotoolboxDecoder,
  hevcVideotoolboxDecoder,
  av1VideotoolboxDecoder,
} from './videotoolbox';

describe('VideoToolbox decoders', () => {
  it('AV1 forces the native decoder, before -i in the orchestrator', () => {
    const args = av1VideotoolboxDecoder.buildInputArgs();
    expect(args).toEqual(['-hwaccel', 'videotoolbox', '-c:v', 'av1', '-noautorotate']);
  });

  it('h264/hevc let ffmpeg auto-pick the decoder (no dav1d ambiguity to force past)', () => {
    expect(h264VideotoolboxDecoder.buildInputArgs()).toEqual([
      '-hwaccel',
      'videotoolbox',
      '-noautorotate',
    ]);
    expect(hevcVideotoolboxDecoder.buildInputArgs()).toEqual([
      '-hwaccel',
      'videotoolbox',
      '-noautorotate',
    ]);
  });

  it('AV1 shares the CPU-download surface contract with h264/hevc', () => {
    expect(av1VideotoolboxDecoder.outputSurface).toBe('cpu');
    expect(av1VideotoolboxDecoder.maxBitDepth).toBe(10);
    expect(av1VideotoolboxDecoder.hwAccel).toBe('videotoolbox');
  });
});
