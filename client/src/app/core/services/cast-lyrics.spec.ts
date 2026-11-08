import { CAST_LYRICS_CHUNK, castLyricsJson, chunkLyrics } from './cast-lyrics';
import type { StructuredLyrics } from './api/lyrics.models';

const doc = (n: number): StructuredLyrics => ({
  id: 1, kind: 'main', lang: 'und', synced: true, offset: 0, source: 'sidecar',
  line: Array.from({ length: n }, (_, i) => ({ start: i * 1000, value: `line ${i} ${'x'.repeat(200)}` })),
} as StructuredLyrics);

describe('cast lyrics', () => {
  it('cuts a long document in messages that join back to it', () => {
    const d = doc(600);
    const msgs = chunkLyrics(d, 7, 3);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.data.length <= CAST_LYRICS_CHUNK && m.seq === 3 && m.parts === msgs.length)).toBe(true);
    expect(msgs.map((m) => m.data).join('')).toBe(castLyricsJson(d));
  });

  it('sends one part for a short document and drops pitch', () => {
    const d = doc(1);
    d.cueLine = [{ index: 0, start: 0, end: 500, value: 'ab', cue: [{ start: 0, end: 500, value: 'ab', byteStart: 0, byteEnd: 2, pitch: 60 }] }];
    const msgs = chunkLyrics(d, 1, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).not.toContain('pitch');
    expect(JSON.parse(msgs[0].data).rows[0].cues[0].byteEnd).toBe(2);
  });
});
