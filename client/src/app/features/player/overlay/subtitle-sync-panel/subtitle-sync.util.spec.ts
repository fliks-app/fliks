import {
  PX_PER_SEC,
  SmoothClock,
  activeCues,
  contentHeight,
  boxTop,
  layoutCues,
  formatOffset,
  isUserScroll,
  offsetFromScroll,
  scrollTopForTime,
  visibleCues,
} from './subtitle-sync.util';

const cues = [
  { start: 1, end: 3, text: 'a' },
  { start: 5, end: 6, text: 'b' },
  { start: 100, end: 102, text: 'c' },
];

describe('subtitle sync maths', () => {
  it('centres time t at scrollTop t*scale with half-viewport padding', () => {
    expect(scrollTopForTime(10)).toBe(10 * PX_PER_SEC);
    expect(contentHeight(120, 400)).toBe(120 * PX_PER_SEC + 400);
    expect(boxTop(layoutCues(cues)[0], 0, 400)).toBe(PX_PER_SEC + 200);
  });

  it('turns a scroll away from now into the offset that brings the centred cue to now', () => {
    // centre shows list position 12 s while video is at 10 s, list laid out with offset 0.5
    const off = offsetFromScroll(12 * PX_PER_SEC, 10, 0.5);
    expect(off).toBeCloseTo(-1.5);
    // the cue that sat at 12 s (start 11.5 unshifted) now starts at 11.5 - 1.5 = 10
    expect(11.5 + off).toBeCloseTo(10);
    expect(offsetFromScroll(10 * PX_PER_SEC, 10, 0.5)).toBeCloseTo(0.5);
  });

  it('finds the cues active under an offset', () => {
    expect(activeCues(cues, 2, 0)).toEqual([0]);
    expect(activeCues(cues, 2, 2)).toEqual([]);
    expect(activeCues(cues, 6.2, 1)).toEqual([1]);
    expect(activeCues(cues, 3, 0)).toEqual([]);
  });

  it('keeps only cues within one viewport of the scroll position', () => {
    const idx = visibleCues(cues, layoutCues(cues), 0, 0, 400).map((v) => v.index);
    expect(idx).toEqual([0, 1]);
    expect(visibleCues(cues, layoutCues(cues), 0, 100 * PX_PER_SEC, 400).map((v) => v.index)).toEqual([2]);
  });

  it('tells programmatic scrolls from user ones', () => {
    expect(isUserScroll(600.4, 600, false)).toBe(false);
    expect(isUserScroll(640, 600, false)).toBe(true);
    expect(isUserScroll(600, 600, true)).toBe(true);
  });

  it('pushes overlapping cues below the previous one', () => {
    const [a, b] = layoutCues([
      { start: 0, end: 1, text: 'a' },
      { start: 0.1, end: 1, text: 'b' },
    ]);
    expect(b.top).toBeGreaterThanOrEqual(a.top + a.height);
  });

  it('advances every frame between bursty time samples', () => {
    const clock = new SmoothClock();
    clock.read(10, 0, true);
    const a = clock.read(10, 16, true);
    const b = clock.read(10, 32, true);
    expect(a).toBeGreaterThan(10);
    expect(b).toBeGreaterThan(a);
    expect(clock.read(10.25, 250, true)).toBeCloseTo(10.25, 1);
    expect(clock.read(5, 266, true)).toBe(5);
    expect(clock.read(5, 1000, false)).toBe(5);
  });

  it('formats the offset with its sign', () => {
    expect(formatOffset(1.2)).toBe('+1.20 s');
    expect(formatOffset(-0.5)).toBe('-0.50 s');
  });
});
