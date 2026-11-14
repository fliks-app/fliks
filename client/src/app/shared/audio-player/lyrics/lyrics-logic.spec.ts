import { describe, expect, it } from 'vitest';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { GAP_GRACE_MS, GAP_MIN_MS, activeIndices, cueFills, cueSegments, layerAligned, tapBack, tapLines, tapStamp, tapStart, toRows } from './lyrics-logic';

const doc = (o: Partial<StructuredLyrics>): StructuredLyrics =>
  ({ id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [], ...o }) as StructuredLyrics;

const activeIndex = (...a: Parameters<typeof activeIndices>) => activeIndices(...a)[0] ?? -1;

describe('lyrics logic', () => {
  const rows = toRows(doc({ line: [{ start: 1000, value: 'a' }, { start: 3000, value: 'b' }, { start: 5000, value: 'c' }] }));

  it('finds the active line, honouring the offset', () => {
    expect(activeIndex(rows, 500, 0)).toBe(-1);
    expect(activeIndex(rows, 3000, 0)).toBe(1);
    expect(activeIndex(rows, 2500, 500)).toBe(1);
    expect(activeIndex(rows, 9000, 0)).toBe(2);
  });

  it('shows no active line in an instrumental gap', () => {
    const cue = (start: number, end: number) => ({ start, end, byteStart: 0, byteEnd: 1, value: 'x' });
    const r = toRows(doc({
      line: [{ start: 0, value: 'a' }, { start: 10000, value: 'b' }, { start: 12000, value: 'c' }],
      cueLine: [
        { index: 0, start: 0, end: 5000, value: 'a', cue: [cue(0, 5000)] },
        { index: 1, start: 10000, end: 11000, value: 'b', cue: [cue(10000, 11000)] },
      ],
    }));
    expect(activeIndex(r, 5000 + GAP_GRACE_MS, 0)).toBe(0);
    expect(activeIndex(r, 5000 + GAP_GRACE_MS + 1, 0)).toBe(-1);
    expect(activeIndex(r, 10000, 0)).toBe(1);
    expect(activeIndex(r, 11000 + GAP_GRACE_MS + 1, 0)).toBe(1);
  });

  it('needs a gap of GAP_MIN_MS', () => {
    const cue = [{ start: 0, end: 1000, byteStart: 0, byteEnd: 1, value: 'x' }];
    const mk = (next: number) =>
      toRows(doc({ line: [{ start: 0, value: 'a' }, { start: next, value: 'b' }], cueLine: [{ index: 0, start: 0, end: 1000, value: 'a', cue }] }));
    expect(activeIndex(mk(1000 + GAP_MIN_MS), 3000, 0)).toBe(-1);
    expect(activeIndex(mk(1000 + GAP_MIN_MS - 1), 3000, 0)).toBe(0);
  });

  it('lights every overlapping line, in any row order', () => {
    const cue = (start: number, end: number) => [{ start, end, byteStart: 0, byteEnd: 1, value: 'x' }];
    const line = (index: number, start: number, end: number) => ({ index, start, end, value: 'x', cue: cue(start, end) });
    const r = toRows(doc({
      line: [{ start: 4000, value: 'c' }, { start: 0, value: 'a' }, { start: 1000, value: 'b' }],
      cueLine: [line(0, 4000, 6000), line(1, 0, 3000), line(2, 1000, 5000)],
    }));
    expect(activeIndices(r, 500, 0)).toEqual([1]);
    expect(activeIndices(r, 2000, 0)).toEqual([1, 2]);
    expect(activeIndices(r, 4500, 0)).toEqual([0, 2]);
    expect(activeIndices(r, 5500, 0)).toEqual([0]);
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

  it('cuts a line at the UTF-8 byte ranges of its cues and keeps the text between them', () => {
    const cue = (byteStart: number, byteEnd: number) => ({ start: 0, end: 1, value: '', byteStart, byteEnd });
    // "caf\u00e9" is 5 bytes, so the second word starts at byte 7 though it is at index 6.
    const segs = cueSegments('caf\u00e9, noir!', [cue(0, 5), cue(7, 11)]);
    expect(segs.map((s) => [s.text, s.cue])).toEqual([['caf\u00e9', 0], [', ', null], ['noir', 1], ['!', null]]);
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
