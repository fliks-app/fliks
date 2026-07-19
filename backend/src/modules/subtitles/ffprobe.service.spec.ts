import { FfprobeService } from './ffprobe.service';

describe('FfprobeService.parseFrameRate', () => {
  const svc = new FfprobeService();
  const parse = (r?: string, avg?: string): string | undefined =>
    (svc as unknown as {
      parseFrameRate(r?: string, avg?: string): string | undefined;
    }).parseFrameRate(r, avg);

  it('normalises a rational to a trimmed decimal', () => {
    expect(parse('24000/1001')).toBe('23.976');
    expect(parse('25/1')).toBe('25');
    expect(parse('30000/1001')).toBe('29.97');
  });

  it('falls back to avg_frame_rate when r_frame_rate is unusable', () => {
    // VFR / some remuxed sources report r_frame_rate 0/0 — without the fallback
    // frameRate is dropped and the segment grid collapses to the integer rate,
    // drifting audio off the video IDR cadence on a fractional-fps source.
    expect(parse('0/0', '24000/1001')).toBe('23.976');
    expect(parse(undefined, '25/1')).toBe('25');
  });

  it('returns undefined only when neither rate is usable', () => {
    expect(parse('0/0', '0/0')).toBeUndefined();
    expect(parse(undefined, undefined)).toBeUndefined();
  });

  it('passes a non-rational string through unchanged', () => {
    expect(parse('23.976')).toBe('23.976');
  });
});
