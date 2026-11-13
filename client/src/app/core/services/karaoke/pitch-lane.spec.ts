import type { StructuredLyrics } from '../api/lyrics.models';
import { intoRange, laneNotes, laneRange } from './pitch-lane';

const c = (start: number, end: number, pitch?: number, golden?: boolean) => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch, golden });
const doc = {
  cueLine: [
    { index: 0, agentId: 'v1', start: 0, end: 2000, value: 'x', cue: [c(0, 1000, 62), c(1000, 2000)] },
    { index: 1, agentId: 'v2', start: 5000, end: 6000, value: 'x', cue: [c(5000, 6000, 71.5, true)] },
  ],
} as unknown as StructuredLyrics;

describe('pitch lane', () => {
  it('spans the song with a margin, an octave at least', () => {
    expect(laneRange(doc)).toEqual({ lo: 60, hi: 74 });
    const flat = { cueLine: [{ index: 0, start: 0, end: 1, value: 'x', cue: [c(0, 1, 60)] }] } as unknown as StructuredLyrics;
    expect(laneRange(flat)).toEqual({ lo: 54, hi: 66 });
  });

  it('keeps the order of the notes: B3 sits under D4', () => {
    const r = { lo: 55, hi: 67 };
    expect(intoRange(59, r)).toBeLessThan(intoRange(62, r));
  });

  it('brings an octave error back into the range, near the anchor', () => {
    const r = { lo: 55, hi: 67 };
    expect(intoRange(89.5, r)).toBe(65.5);
    expect(intoRange(50, r, 62)).toBe(62);
    expect(intoRange(74, r, 61)).toBe(62);
  });

  it('draws every note of a held word', () => {
    const held = { cueLine: [{ index: 0, start: 0, end: 1000, value: 'x', cue: [{ ...c(0, 1000, 60), notes: [{ start: 0, end: 400, pitch: 60 }, { start: 400, end: 1000, pitch: 64 }] }] }] } as unknown as StructuredLyrics;
    expect(laneNotes(held, 0, 1000, laneRange(held)).map((n) => [n.start, n.midi])).toEqual([[0, 60], [400, 64]]);
  });

  it('lists the pitched cues inside the window only', () => {
    const r = laneRange(doc);
    expect(laneNotes(doc, 500, 4000, r).map((n) => n.start)).toEqual([0]);
    const [n] = laneNotes(doc, 4000, 9000, r);
    expect([n.midi, n.golden, n.agentId]).toEqual([71.5, true, 'v2']);
  });
});
