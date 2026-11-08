import type { StructuredLyrics } from '../api/lyrics.models';
import { foldPitch, laneNotes } from './pitch-lane';

const c = (start: number, end: number, pitch?: number, golden?: boolean) => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch, golden });
const doc = {
  cueLine: [
    { index: 0, agentId: 'v1', start: 0, end: 2000, value: 'x', cue: [c(0, 1000, 62), c(1000, 2000)] },
    { index: 1, agentId: 'v2', start: 5000, end: 6000, value: 'x', cue: [c(5000, 6000, 71.5, true)] },
  ],
} as unknown as StructuredLyrics;

describe('pitch lane', () => {
  it('folds octaves, negatives included', () => {
    expect(foldPitch(74)).toBe(2);
    expect(foldPitch(-1)).toBe(11);
  });

  it('lists the pitched cues inside the window only', () => {
    expect(laneNotes(doc, 500, 4000).map((n) => n.start)).toEqual([0]);
    const [n] = laneNotes(doc, 4000, 9000);
    expect([n.fold, n.golden, n.agentId]).toEqual([11.5, true, 'v2']);
  });
});
