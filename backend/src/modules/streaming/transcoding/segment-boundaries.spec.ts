import {
  computeSegmentDurations,
  boundariesFromDurations,
  secondsToSegmentIndex,
  segmentIndexToSeconds,
} from './segment-boundaries';

describe('computeSegmentDurations', () => {
  it('cuts at the first keyframe past each advancing target, tail to duration', () => {
    // SEG=6. Keyframes [0,2,4,7,9,13,15], duration 18.
    //  target 6  → cut at kf 7  (seg 0..7  = 7s), target 12
    //  target 12 → cut at kf 13 (seg 7..13 = 6s), target 18
    //  tail      → 13..18 = 5s
    const durs = computeSegmentDurations([0, 2, 4, 7, 9, 13, 15], 18, 6);
    expect(durs).toEqual([7, 6, 5]);
  });

  it('extends the timeline when a keyframe sits past the reported duration', () => {
    // Last keyframe (20) > reported duration (15): total becomes 20, no negative tail.
    const durs = computeSegmentDurations([0, 5, 10, 20], 15, 6);
    expect(durs.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 3);
    expect(durs.every((d) => d > 0)).toBe(true);
  });

  it('returns empty when there are no keyframes', () => {
    expect(computeSegmentDurations([], 100, 6)).toEqual([]);
  });
});

describe('boundary helpers', () => {
  const boundaries = boundariesFromDurations([7, 6, 5]); // [0,7,13,18]

  it('builds cumulative start times plus the final end', () => {
    expect(boundaries).toEqual([0, 7, 13, 18]);
  });

  it('maps a time to the segment whose window contains it', () => {
    expect(secondsToSegmentIndex(boundaries, 0)).toBe(0);
    expect(secondsToSegmentIndex(boundaries, 6.9)).toBe(0);
    expect(secondsToSegmentIndex(boundaries, 7)).toBe(1);
    expect(secondsToSegmentIndex(boundaries, 12.9)).toBe(1);
    expect(secondsToSegmentIndex(boundaries, 13)).toBe(2);
    expect(secondsToSegmentIndex(boundaries, 999)).toBe(2);
  });

  it('maps a segment index back to its start time (consistent with the playlist)', () => {
    expect(segmentIndexToSeconds(boundaries, 0)).toBe(0);
    expect(segmentIndexToSeconds(boundaries, 1)).toBe(7);
    expect(segmentIndexToSeconds(boundaries, 2)).toBe(13);
  });
});
