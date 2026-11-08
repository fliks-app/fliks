import { describe, expect, it } from 'vitest';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { activeIndex, cueFills, layerAligned, tapBack, tapLines, tapStamp, tapStart, toRows } from './lyrics-logic';

const doc = (o: Partial<StructuredLyrics>): StructuredLyrics =>
  ({ id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [], ...o }) as StructuredLyrics;

describe('lyrics logic', () => {
  const rows = toRows(doc({ line: [{ start: 1000, value: 'a' }, { start: 3000, value: 'b' }, { start: 5000, value: 'c' }] }));

  it('finds the active line, honouring the offset', () => {
    expect(activeIndex(rows, 500, 0)).toBe(-1);
    expect(activeIndex(rows, 3000, 0)).toBe(1);
    expect(activeIndex(rows, 2500, 500)).toBe(1);
    expect(activeIndex(rows, 9000, 0)).toBe(2);
  });

  it('has no active line for untimed rows', () => {
    expect(activeIndex(toRows(doc({ synced: false, line: [{ value: 'x' }] })), 5000, 0)).toBe(-1);
  });

  it('prefers the cue line of an index', () => {
    const r = toRows(doc({ line: [{ start: 0, value: 'ab' }], cueLine: [{ index: 0, start: 0, end: 20, value: 'ab', agentId: 'v1', cue: [] }] }));
    expect(r[0]).toMatchObject({ end: 20, agentId: 'v1' });
  });

  it('fills cues by the clock', () => {
    const cues = [{ start: 0, end: 100 }, { start: 100, end: 300 }, { start: 300, end: 400 }] as never[];
    expect(cueFills(cues, 200, 0)).toEqual([100, 50, 0]);
    expect(cueFills(cues, 100, 100)).toEqual([100, 50, 0]);
  });

  it('aligns a layer only on equal line counts', () => {
    expect(layerAligned(doc({ line: [{ value: 'a' }] }), doc({ line: [{ value: 'b' }] }))).toBe(true);
    expect(layerAligned(doc({ line: [{ value: 'a' }] }), doc({ line: [] }))).toBe(false);
  });

  it('taps, undoes and completes a sync session', () => {
    let s = tapStart('one\n\n two \nthree');
    expect(s.lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
    s = tapStamp(tapStamp(s, 1000.4), 500);
    expect(s.lines.map((l) => l.start)).toEqual([1000, 1000, undefined]);
    expect(tapLines(s)).toBeNull();
    s = tapBack(s);
    expect(s).toMatchObject({ next: 1 });
    expect(s.lines[1].start).toBeUndefined();
    s = tapStamp(tapStamp(s, 2000), 3000);
    expect(tapLines(s)).toEqual([
      { start: 1000, end: 2000, text: 'one' },
      { start: 2000, end: 3000, text: 'two' },
      { start: 3000, end: undefined, text: 'three' },
    ]);
  });
});
