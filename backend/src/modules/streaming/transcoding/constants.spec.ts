import {
  parseSourceFps,
  realSegmentSeconds,
  secondsToSegmentIndex,
} from './constants';

describe('parseSourceFps', () => {
  it('parses decimal frame rates', () => {
    expect(parseSourceFps('23.976')).toBeCloseTo(23.976, 3);
    expect(parseSourceFps('24')).toBe(24);
  });

  it('returns undefined for missing / empty / zero', () => {
    expect(parseSourceFps(undefined)).toBeUndefined();
    expect(parseSourceFps('')).toBeUndefined();
    expect(parseSourceFps('0')).toBeUndefined();
  });
});

describe('realSegmentSeconds', () => {
  it('equals the nominal duration for integer / unknown fps', () => {
    expect(realSegmentSeconds(3, 24)).toBe(3);
    expect(realSegmentSeconds(3, 30)).toBe(3);
    expect(realSegmentSeconds(3, undefined)).toBe(3);
  });

  it('honours a non-default segment duration', () => {
    expect(realSegmentSeconds(6, 24)).toBe(6);
    expect(realSegmentSeconds(6, undefined)).toBe(6);
  });

  it('returns gop/fps for fractional fps', () => {
    // round(3 × 23.976) = 72 frames → 72 / 23.976 ≈ 3.003s
    expect(realSegmentSeconds(3, 23.976)).toBeCloseTo(72 / 23.976, 6);
  });

  it('keeps secondsToSegmentIndex on the same fractional grid', () => {
    // seg-N starts at N × 3.003; t just under the 2nd boundary is still seg 1.
    expect(secondsToSegmentIndex(72 / 23.976, 3, 23.976)).toBe(1);
    expect(secondsToSegmentIndex((72 / 23.976) * 2 - 0.001, 3, 23.976)).toBe(1);
  });
});
