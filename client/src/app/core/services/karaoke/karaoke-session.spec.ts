import type { LyricsCue, StructuredLyrics } from '../api/lyrics.models';
import { FrameStore, calibrate, onsets, scoreAll, sides } from './karaoke-session';
import type { PitchFrame } from './karaoke-score';

const cue = (start: number, end: number, pitch: number): LyricsCue => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch });
const line = (index: number, agentId: string, cues: LyricsCue[]) => ({ index, agentId, start: cues[0].start, end: cues[0].end, value: 'x', cue: cues });
const doc = (cueLine: StructuredLyrics['cueLine'], agents: StructuredLyrics['agents']): StructuredLyrics => ({
  id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, displayArtist: '', displayTitle: '', source: 's', reviewed: false, preferred: true, line: [], agents, cueLine,
});
const sing = (from: number, to: number, midi: number | null): PitchFrame[] => Array.from({ length: (to - from) / 20 }, (_, i) => ({ t: from + i * 20, midi }));

describe('karaoke session', () => {
  const duet = doc(
    [line(0, 'v1', [cue(0, 1000, 60)]), line(1, 'v2', [cue(1000, 2000, 64)])],
    [{ id: 'v1', role: 'main' }, { id: 'v2', role: 'voice' }, { id: 'bg', role: 'bg' }],
  );

  it('keeps the sides that sing', () => {
    expect(sides(duet)).toEqual(['v1', 'v2']);
  });

  it('scores the n-th singer against the n-th side of a duet', () => {
    const store = new FrameStore();
    store.add(7, sing(0, 1000, 60));
    store.add(9, sing(1000, 2000, 64));
    const [a, b] = scoreAll(duet, store, 'hard', 0);
    expect([a.agentId, a.score, b.agentId, b.score]).toEqual(['v1', 10000, 'v2', 10000]);
  });

  it('gives a lone singer every line', () => {
    const store = new FrameStore();
    store.add(7, [...sing(0, 1000, 60), ...sing(1000, 2000, 64)]);
    const [a] = scoreAll(duet, store, 'hard', 0);
    expect([a.agentId, a.score]).toEqual([null, 10000]);
  });

  it('scores a group line for every singer', () => {
    const d = doc([line(0, 'g', [cue(0, 1000, 60)])], [{ id: 'v1', role: 'main' }, { id: 'v2', role: 'voice' }, { id: 'g', role: 'group' }]);
    const store = new FrameStore();
    store.add(7, sing(0, 1000, 60));
    store.add(9, sing(0, 1000, 72));
    expect(scoreAll(d, store, 'hard', 0).map((r) => r.score)).toEqual([10000, 10000]);
  });

  it('bounds the frames it keeps', () => {
    const store = new FrameStore();
    store.add(1, Array.from({ length: 20050 }, (_, i) => ({ t: i, midi: 60 })));
    expect(store.frames(1).length).toBe(20000);
    expect(store.frames(1)[0].t).toBe(50);
  });

  it('measures the capture delay from the onsets', () => {
    const cues = [cue(0, 500, 60), cue(2000, 2500, 60), cue(4000, 4500, 60)];
    const d = doc(cues.map((c, i) => line(i, 'v1', [c])), [{ id: 'v1', role: 'main' }]);
    const take = [...sing(300, 800, 60), ...sing(2300, 2800, 60), ...sing(4300, 4800, 60)];
    expect(onsets(take)).toEqual([300, 2300, 4300]);
    expect(calibrate(d, take)).toBe(300);
  });
});
