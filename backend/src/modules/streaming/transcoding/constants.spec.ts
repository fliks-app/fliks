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

  it('returns the true whole-ms GOP length for fractional fps', () => {
    // round(3 × 23.976) = 72 frames. The stored fps is rounded to 3 decimals,
    // so raw 72 / 23.976 = 3.0030030… overshoots the true GOP; snapping to the
    // ms restores 72·1001/24000 = 3.003 exactly. As -hls_time the raw value
    // makes the muxer merge two GOPs into the run's first segment.
    expect(realSegmentSeconds(3, 23.976)).toBe(3.003);
    expect(realSegmentSeconds(3, 23.976)).toBeLessThanOrEqual((72 * 1001) / 24000);
    // 6s setting → 144 frames → 6.006s.
    expect(realSegmentSeconds(6, 23.976)).toBe(6.006);
    // 29.97 (30000/1001): 90 frames → 3.003s.
    expect(realSegmentSeconds(3, 29.97)).toBe(3.003);
  });

  it('keeps secondsToSegmentIndex on the same grid', () => {
    const seg = realSegmentSeconds(3, 23.976); // 3.003
    // seg-N starts at N × seg; t just under the 2nd boundary is still seg 1.
    expect(secondsToSegmentIndex(seg, 3, 23.976)).toBe(1);
    expect(secondsToSegmentIndex(seg * 2 - 0.001, 3, 23.976)).toBe(1);
  });
});
