import { parseSourceFps } from './fps';

describe('parseSourceFps', () => {
  it('parses decimal frame rates', () => {
    expect(parseSourceFps('23.976')).toBeCloseTo(23.976, 3);
    expect(parseSourceFps('24')).toBe(24);
  });

  it('parses rational frame rates (ffprobe r_frame_rate)', () => {
    // parseFloat('24000/1001') would yield 24000 and blow up the GOP/seg grid.
    expect(parseSourceFps('24000/1001')).toBeCloseTo(24000 / 1001, 6);
    expect(parseSourceFps('30000/1001')).toBeCloseTo(30000 / 1001, 6);
    expect(parseSourceFps('30/1')).toBe(30);
  });

  it('returns undefined for missing / empty / zero / degenerate rationals', () => {
    expect(parseSourceFps(undefined)).toBeUndefined();
    expect(parseSourceFps('')).toBeUndefined();
    expect(parseSourceFps('0')).toBeUndefined();
    expect(parseSourceFps('0/0')).toBeUndefined();
    expect(parseSourceFps('24000/0')).toBeUndefined();
    expect(parseSourceFps('0/1001')).toBeUndefined();
  });
});
