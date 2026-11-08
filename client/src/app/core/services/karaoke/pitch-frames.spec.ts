import { decodeBatch, encodeBatch } from './pitch-frames';

describe('pitch frames', () => {
  it('round-trips at a tenth of a semitone', () => {
    const out = decodeBatch(encodeBatch([{ t: 1000.4, midi: 60.26 }, { t: 1020, midi: null }]));
    expect(out).toEqual([{ t: 1000, midi: 60.3 }, { t: 1020, midi: null }]);
  });
  it('drops malformed input', () => {
    expect(decodeBatch('nope')).toEqual([]);
    expect(decodeBatch(JSON.stringify({ k: 'pf', t: [1], m: [] }))).toEqual([]);
    expect(decodeBatch(JSON.stringify({ k: 'pf', t: [-1, 5], m: [600, 'x'] }))).toEqual([]);
    expect(decodeBatch(new ArrayBuffer(4))).toEqual([]);
  });
});
