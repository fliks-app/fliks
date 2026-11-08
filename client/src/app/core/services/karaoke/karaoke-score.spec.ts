import { estimateLatency, foldedDistance, scoreSinger, type PitchFrame } from './karaoke-score';

const cue = (start: number, end: number, pitch: number, golden = false) => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch, golden });
const sing = (from: number, to: number, midi: number | null): PitchFrame[] =>
  Array.from({ length: (to - from) / 20 }, (_, i) => ({ t: from + i * 20, midi }));

describe('karaoke score', () => {
  it('folds octaves', () => {
    expect(foldedDistance(48, 60)).toBe(0);
    expect(foldedDistance(60, 66.5)).toBeCloseTo(5.5);
  });

  it('is full for a perfect take, even an octave away, and zero for silence', () => {
    const lines = [{ cues: [cue(0, 1000, 60), cue(1000, 2000, 64)] }];
    const perfect = [...sing(0, 1000, 48), ...sing(1000, 2000, 76)];
    expect(scoreSinger(lines, perfect, 'hard').score).toBe(10000);
    expect(scoreSinger(lines, sing(0, 2000, null), 'hard').score).toBe(0);
  });

  it('honours the difficulty window', () => {
    const lines = [{ cues: [cue(0, 1000, 60)] }];
    const off = sing(0, 1000, 61.2);
    expect(scoreSinger(lines, off, 'easy').score).toBeGreaterThan(0);
    expect(scoreSinger(lines, off, 'hard').score).toBe(0);
  });

  it('weights golden notes twice and adds a line bonus', () => {
    const lines = [{ cues: [cue(0, 1000, 60, true), cue(1000, 2000, 62)] }];
    const half = scoreSinger(lines, sing(1000, 2000, 62), 'medium');
    const goldenOnly = scoreSinger(lines, sing(0, 1000, 60), 'medium');
    expect(goldenOnly.score).toBeGreaterThan(half.score);
    expect(scoreSinger(lines, [...sing(0, 1000, 60), ...sing(1000, 2000, 62)], 'medium').lineBonus).toBeGreaterThan(0);
  });

  it('removes the device latency', () => {
    const lines = [{ cues: [cue(0, 1000, 60)] }];
    expect(scoreSinger(lines, sing(150, 1150, 60), 'medium', 0, 150).score).toBe(10000);
  });

  it('estimates a latency from onsets', () => {
    expect(estimateLatency([120, 1130, 2125], [0, 1000, 2000])).toBe(125);
    expect(estimateLatency([120], [0])).toBeNull();
  });
});
