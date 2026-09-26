import {
  computeSegmentGrid,
  gridSegmentIndex,
  seeksPastKeyframe,
  type Keyframe,
} from './segment-boundaries';

const kf = (...pts: number[]): Keyframe[] => pts.map((p) => ({ pts: p, dts: p }));

describe('computeSegmentGrid', () => {
  it('cuts at the first keyframe past each advancing target, tail to the end', () => {
    // SEG=6. Keyframes [0,2,4,7,9,13,15], end 18.
    //  target 6  → cut at kf 7  (seg 0..7  = 7s), target 12
    //  target 12 → cut at kf 13 (seg 7..13 = 6s), target 18
    //  tail      → 13..18 = 5s
    const g = computeSegmentGrid(kf(0, 2, 4, 7, 9, 13, 15), 0, 18, 6)!;
    expect(g.durations).toEqual([7, 6, 5]);
    expect(g.boundaries).toEqual([0, 7, 13, 18]);
    expect(g.firstKeyframe).toEqual([0, 3, 5, 7]);
  });

  it('extends the timeline when a keyframe sits past the end', () => {
    const g = computeSegmentGrid(kf(0, 5, 10, 20), 0, 15, 6)!;
    expect(g.boundaries.at(-1)).toBe(20);
    expect(g.durations.every((d) => d > 0)).toBe(true);
  });

  it('counts from the origin on a source with a non-zero start', () => {
    const g = computeSegmentGrid(kf(1.4, 4.4, 7.4), 1.4, 10.4, 3)!;
    g.durations.forEach((d) => expect(d).toBeCloseTo(3, 6));
    expect(g.boundaries[0]).toBe(1.4);
  });

  it('starts on the first keyframe shown when an edit list starts mid-GOP', () => {
    // The edit starts presentation at 0: the keyframe at -1.52 and its GOP are
    // pre-roll, and nothing before 0.48 decodes without them.
    const g = computeSegmentGrid(kf(-1.52, 0.48, 2.48, 4.48, 6.48), 0, 8, 2)!;
    expect(g.boundaries).toEqual([0.48, 2.48, 4.48, 6.48, 8]);
    expect(g.firstKeyframe).toEqual([0, 1, 2, 3, 4]);
    expect(g.keyframes[0].pts).toBe(0.48);
  });

  it('keeps a keyframe on the last frame inside the last segment', () => {
    const g = computeSegmentGrid(kf(0, 3, 6, 8.9995), 0, 9, 3)!;
    expect(g.boundaries).toEqual([0, 3, 6, 9]);
    expect(g.firstKeyframe).toEqual([0, 1, 2, 4]);
  });

  it('is null without keyframes', () => {
    expect(computeSegmentGrid([], 0, 100, 6)).toBeNull();
  });
});

describe('gridSegmentIndex', () => {
  const boundaries = [0, 7, 13, 18];

  it('maps a time to the segment whose window contains it', () => {
    expect(gridSegmentIndex(boundaries, 0, 0)).toBe(0);
    expect(gridSegmentIndex(boundaries, 6.9, 0)).toBe(0);
    expect(gridSegmentIndex(boundaries, 7, 0)).toBe(1);
    expect(gridSegmentIndex(boundaries, 13, 0)).toBe(2);
    expect(gridSegmentIndex(boundaries, 999, 0)).toBe(2);
  });

  it('places a content position on source-time boundaries through the origin', () => {
    // A TS starting at 2.8: content 20 s is source 22.8, in [20.8, 23.8).
    const ts = [2.8, 5.8, 8.8, 11.8, 14.8, 17.8, 20.8, 23.8, 26.8];
    expect(gridSegmentIndex(ts, 20, 2.8)).toBe(6);
    expect(gridSegmentIndex(ts, 17.9, 2.8)).toBe(5);
  });
});

describe('seeksPastKeyframe', () => {
  it('is MPEG-TS, by format name or, unprobed, by extension', () => {
    expect(seeksPastKeyframe({ formatName: 'mpegts' }, '/m/a.mkv')).toBe(true);
    expect(seeksPastKeyframe({ formatName: 'matroska,webm' }, '/m/a.ts')).toBe(false);
    expect(seeksPastKeyframe({ formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }, '/m/a.mp4')).toBe(false);
    expect(seeksPastKeyframe({}, '/m/a.MTS')).toBe(true);
    expect(seeksPastKeyframe(undefined, '/m/a.mkv')).toBe(false);
  });
});
