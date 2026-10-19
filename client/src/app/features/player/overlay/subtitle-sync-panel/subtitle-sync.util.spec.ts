import {
  PX_PER_SEC,
  SmoothClock,
  activeCues,
  TimeMap,
  boxTop,
  layoutCues,
  formatOffset,
  isUserScroll,
  offsetFromScroll,
  visibleCues,
  visibleTicks,
  formatClock,
  holdStep,
} from './subtitle-sync.util';

const cues = [
  { start: 1, end: 3, text: 'a' },
  { start: 5, end: 6, text: 'b' },
  { start: 100, end: 102, text: 'c' },
];

describe('subtitle sync maths', () => {
  it('maps cue starts to their box tops and round-trips, even in dense dialogue', () => {
    const dense = Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, text: `c${i}` }));
    for (const [list, base] of [[cues, 0], [cues, 1.5], [dense, 0], [dense, -2]] as const) {
      const boxes = layoutCues(list);
      const map = new TimeMap(list, boxes, base);
      list.forEach((c, i) => {
        expect(map.px(c.start + base)).toBeCloseTo(boxes[i].top + base * PX_PER_SEC);
        expect(map.time(map.px(c.start + base))).toBeCloseTo(c.start + base);
      });
      if (base >= 0) expect(map.px(0)).toBeCloseTo(0);
      expect(map.time(map.px(7.3))).toBeCloseTo(7.3);
    }
    const map = new TimeMap(dense, layoutCues(dense), 0);
    expect(map.px(19)).toBeGreaterThan(19 * PX_PER_SEC);
  });

  it('turns a scroll away from now into the offset that brings the centred cue to now', () => {
    const map = new TimeMap(cues, layoutCues(cues), 0.5);
    // scrolled to the list position of video time 12 while the video is at 10, list laid out with 0.5
    const off = offsetFromScroll(map.px(12), 10, map);
    expect(off).toBeCloseTo(-1.5);
    expect(offsetFromScroll(map.px(10), 10, map)).toBeCloseTo(0.5);
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

  it('puts a labelled tick every 5 s at video time, under the centre line when scrolled to it', () => {
    const map = new TimeMap(cues, layoutCues(cues), 0);
    const ticks = visibleTicks(map, map.px(60), 400, 3600);
    const at60 = ticks.find((t) => t.time === 60)!;
    expect(at60.label).toBe('01:00');
    expect(at60.top).toBeCloseTo(map.px(60) + 200);
    expect(ticks.find((t) => t.time === 61)!.label).toBeNull();
    expect(ticks[0].time).toBeGreaterThanOrEqual(0);
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('speeds the key repeat up the longer the key is held', () => {
    expect([0, 499, 500, 1499, 1500, 5000].map(holdStep)).toEqual([0.1, 0.1, 0.25, 0.25, 0.5, 0.5]);
  });
});
