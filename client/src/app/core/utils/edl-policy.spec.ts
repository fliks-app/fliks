import { describe, expect, it } from 'vitest';
import { decodeEdlWire, encodeEdlWire, jsonBytes, EdlSkipPolicy, isMutedAt, muteRangesOf, nextMuteEdge, type EdlRange } from './edl-policy';

const r = (start: number, end: number, action: EdlRange['action']): EdlRange => ({ start, end, action });

describe('mute helpers', () => {
  const mute = muteRangesOf([r(20, 21, 'mute'), r(21.1, 22, 'mute'), r(30, 31, 'mute'), r(5, 6, 'cut')]);

  it('keeps only mute ranges and merges gaps up to 0.2 s', () => {
    expect(mute).toEqual([{ start: 20, end: 22 }, { start: 30, end: 31 }]);
    expect(muteRangesOf([r(1, 2, 'mute'), r(2.3, 3, 'mute')])).toHaveLength(2);
  });
  it('is half-open', () => {
    expect(isMutedAt(mute, 20)).toBe(true);
    expect(isMutedAt(mute, 22)).toBe(false);
  });
  it('finds the next edge', () => {
    expect(nextMuteEdge(mute, 0)).toBe(20);
    expect(nextMuteEdge(mute, 20)).toBe(22);
    expect(nextMuteEdge(mute, 25)).toBe(30);
    expect(nextMuteEdge(mute, 31)).toBeNull();
  });
});

describe('EdlSkipPolicy', () => {
  const ranges = [r(0, 5, 'cut'), r(20, 21, 'mute'), r(40, 60, 'commercial'), r(90, 105, 'cut')];

  it('skips a range at 0 and a seek landing inside a cut', () => {
    const p = new EdlSkipPolicy(ranges);
    expect(p.resolve(0, 100)).toEqual({ kind: 'seek', to: 5, action: 'cut' });
    expect(p.resolve(2, 100)).toEqual({ kind: 'seek', to: 5, action: 'cut' });
    expect(p.resolve(5, 100)).toEqual({ kind: 'none' });
  });
  it('skips a commercial once per session', () => {
    const p = new EdlSkipPolicy(ranges);
    expect(p.resolve(41, 100)).toEqual({ kind: 'seek', to: 60, action: 'commercial' });
    expect(p.resolve(45, 100)).toEqual({ kind: 'none' });
    expect(p.nextBoundary(30)).toBe(90);
  });
  it('lets a commercial tail play and never skips mute', () => {
    const p = new EdlSkipPolicy(ranges);
    expect(p.resolve(59.5, 100)).toEqual({ kind: 'none' });
    expect(p.resolve(20.5, 100)).toEqual({ kind: 'none' });
  });
  it('chains touching ranges', () => {
    const p = new EdlSkipPolicy([r(10, 20, 'cut'), r(20, 30, 'commercial')]);
    expect(p.resolve(12, 100)).toEqual({ kind: 'seek', to: 30, action: 'cut' });
  });
  it('ends when a range reaches EOF', () => {
    const p = new EdlSkipPolicy(ranges);
    expect(p.resolve(95, 100)).toEqual({ kind: 'end', action: 'cut' });
    expect(new EdlSkipPolicy([r(90, 99.97, 'cut')]).resolve(91, 100)).toEqual({ kind: 'end', action: 'cut' });
  });
  it('reports the next boundary', () => {
    const p = new EdlSkipPolicy(ranges);
    expect(p.nextBoundary(5)).toBe(40);
    expect(p.nextBoundary(70)).toBe(90);
    expect(p.nextBoundary(95)).toBeNull();
  });
  it('keeps skipped commercials across replaceRanges', () => {
    const p = new EdlSkipPolicy(ranges);
    p.resolve(41, 100);
    p.replaceRanges(ranges);
    expect(p.resolve(45, 100)).toEqual({ kind: 'none' });
    p.replaceRanges([r(40, 50, 'commercial'), r(70, 80, 'commercial')]);
    expect(p.resolve(41, 100)).toEqual({ kind: 'seek', to: 50, action: 'commercial' });
  });
  it('keeps skipped commercials when the timeline shifts', () => {
    const p = new EdlSkipPolicy(ranges);
    p.resolve(41, 100);
    p.replaceRanges(ranges.map((x) => ({ ...x, start: x.start + 1.5, end: x.end + 1.5 })));
    expect(p.resolve(46, 100)).toEqual({ kind: 'none' });
  });
  it('treats a position within EDGE_EPS of a range end as outside', () => {
    const p = new EdlSkipPolicy([r(10, 20, 'cut')]);
    expect(p.resolve(19.995, 100)).toEqual({ kind: 'none' });
    expect(p.resolve(19.98, 100)).toEqual({ kind: 'seek', to: 20, action: 'cut' });
  });
  it('is never end without a range hit', () => {
    expect(new EdlSkipPolicy([r(10, 20, 'cut')]).resolve(99.99, 100)).toEqual({ kind: 'none' });
  });
});

describe('EdlSkipPolicy manual commercials', () => {
  const manual = (rs: EdlRange[]) => new EdlSkipPolicy(rs, { autoSkipCommercials: false });
  it('resolve ignores commercials but still skips cuts', () => {
    const p = manual([r(10, 60, 'commercial'), r(100, 110, 'cut')]);
    expect(p.resolve(20, 600)).toEqual({ kind: 'none' });
    expect(p.nextBoundary(0)).toBe(100);
    expect(p.resolve(105, 600)).toEqual({ kind: 'seek', to: 110, action: 'cut' });
  });
  it('commercialAt honors the tail, EDGE_EPS and skipped state', () => {
    const p = manual([r(0, 60, 'commercial')]);
    expect(p.commercialAt(0)).toEqual({ index: 0, start: 0, end: 60 });
    expect(p.commercialAt(58.9)).not.toBeNull();
    expect(p.commercialAt(59)).toBeNull();
    expect(p.commercialAt(60)).toBeNull();
    p.skipCommercialAt(10, 600);
    expect(p.commercialAt(10)).toBeNull();
  });
  it('skipCommercialAt chains through adjacent ranges and ends at EOF', () => {
    const p = manual([r(10, 60, 'commercial'), r(60, 70, 'cut'), r(70, 90, 'commercial')]);
    expect(p.skipCommercialAt(5, 600)).toEqual({ kind: 'none' });
    expect(p.skipCommercialAt(20, 600)).toEqual({ kind: 'seek', to: 90, action: 'commercial' });
    const q = manual([r(10, 600, 'commercial')]);
    expect(q.skipCommercialAt(20, 600)).toEqual({ kind: 'end', action: 'commercial' });
  });
  it('a skipped commercial plays normally and the setter switches modes', () => {
    const p = manual([r(10, 60, 'commercial')]);
    p.skipCommercialAt(20, 600);
    p.setAutoSkipCommercials(true);
    expect(p.resolve(20, 600)).toEqual({ kind: 'none' });
    const q = manual([r(10, 60, 'commercial')]);
    q.setAutoSkipCommercials(true);
    expect(q.resolve(20, 600)).toEqual({ kind: 'seek', to: 60, action: 'commercial' });
  });
});

describe('edl wire', () => {
  it('round-trips ranges at ms precision', () => {
    const rs = [r(0, 5, 'cut'), r(20.0004, 21.5, 'mute'), r(40, 60, 'commercial')];
    expect(decodeEdlWire(encodeEdlWire(rs))).toEqual([r(0, 5, 'cut'), r(20, 21.5, 'mute'), r(40, 60, 'commercial')]);
  });
  it('costs about 12 bytes per range', () => {
    const rs = Array.from({ length: 1000 }, (_, i) => r(i * 30 + 1.25, i * 30 + 3.5, 'mute' as const));
    expect(jsonBytes(encodeEdlWire(rs)) / 1000).toBeLessThan(14);
  });
});
