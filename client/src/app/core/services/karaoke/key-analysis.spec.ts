import type { KaraokeAnalysis } from '../api/karaoke.models';
import { VoiceRange, fitsVoice, keyName, noteName } from './key-analysis';

const names = { major: 'C Db D Eb E F F# G Ab A Bb B'.split(' '), minor: 'Cm C#m Dm Ebm Em Fm F#m Gm G#m Am Bbm Bm'.split(' ') };
const song: KaraokeAnalysis = { tuningCents: 0, lowMidi: 57.2, highMidi: 69 };

describe('key analysis', () => {
  beforeEach(() => localStorage.clear());

  it('names the shifted key and note', () => {
    expect(keyName({ tonic: 9, mode: 'minor' }, 2, names)).toBe('Bm');
    expect(keyName({ tonic: 0, mode: 'major' }, -1, names)).toBe('B');
    expect(noteName(60, names.major)).toBe('C4');
    expect(noteName(57.4, names.major)).toBe('A3');
  });

  it('fits the voice an octave away, not a span wider than it', () => {
    expect(fitsVoice(song, 0, null)).toBeNull();
    expect(fitsVoice(song, 0, { low: 45, high: 57 })).toBe(true);
    expect(fitsVoice(song, 4, { low: 45, high: 57 })).toBe(false);
    expect(fitsVoice(song, 0, { low: 50, high: 58 })).toBe(false);
  });

  it('learns a range once enough was sung and keeps it', () => {
    const v = new VoiceRange();
    for (let i = 0; i < 1000; i++) v.add(55);
    expect(v.range()).toBeNull();
    for (let i = 0; i < 2000; i++) v.add(60 + (i % 5));
    v.add(100);
    v.save();
    expect(new VoiceRange().range()).toEqual({ low: 55, high: 64 });
  });
});
