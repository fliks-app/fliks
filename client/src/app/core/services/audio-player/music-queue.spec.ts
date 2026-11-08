import { describe, expect, it } from 'vitest';
import { MusicQueue, type MusicTrackRequest } from './music-queue';
import { replayGainFactor } from './replay-gain';

const t = (id: number, mediaId = 1): MusicTrackRequest => ({
  itemId: id,
  mediaId,
  title: `T${id}`,
  artists: 'A',
  albumTitle: 'Al',
  coverUrl: null,
  durationSeconds: 100,
  gain: null,
  peak: null,
  albumGain: null,
  albumPeak: null,
});
const ids = (q: MusicQueue) => q.tracks.map((x) => x.itemId);
const make = (n = 5, start = 0) => {
  const q = new MusicQueue();
  q.set(Array.from({ length: n }, (_, i) => t(i + 1)), start);
  return q;
};

describe('MusicQueue', () => {
  it('starts at the index and steps through, stopping at the end with repeat off', () => {
    const q = make(3, 1);
    expect(q.current?.itemId).toBe(2);
    expect(q.next(true)?.itemId).toBe(3);
    expect(q.next(true)).toBeNull();
    expect(q.current?.itemId).toBe(3);
  });

  it('repeat all wraps both ways, repeat one replays on an end but skips on a manual next', () => {
    const q = make(3);
    q.repeat = 'all';
    expect(q.previous()?.itemId).toBe(3);
    expect(q.next(true)?.itemId).toBe(1);
    q.repeat = 'one';
    expect(q.peekNext()).toBeNull();
    expect(q.next(true)?.itemId).toBe(1);
    expect(q.next(false)?.itemId).toBe(2);
  });

  it('shuffle keeps the current track first and unshuffle restores the order around it', () => {
    const q = make(6, 2);
    q.setShuffle(true, () => 0);
    expect(q.index).toBe(0);
    expect(q.current?.itemId).toBe(3);
    expect(ids(q).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    q.setShuffle(false);
    expect(ids(q)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(q.current?.itemId).toBe(3);
  });

  it('adds next and last, and keeps both after an unshuffle', () => {
    const q = make(3);
    q.setShuffle(true, () => 0.5);
    q.addNext([t(10)]);
    q.addLast([t(11)]);
    expect(ids(q)[1]).toBe(10);
    expect(ids(q).at(-1)).toBe(11);
    q.setShuffle(false);
    expect(ids(q)).toEqual([1, 2, 3, 10, 11]);
  });

  it('removes entries and keeps the current one', () => {
    const q = make(4, 2);
    q.remove(0);
    expect(q.current?.itemId).toBe(3);
    q.remove(q.index);
    expect(q.current?.itemId).toBe(4);
    q.remove(q.index);
    expect(q.current?.itemId).toBe(2);
  });

  it('reorders without losing the current track', () => {
    const q = make(4, 1);
    q.move(3, 0);
    expect(ids(q)).toEqual([4, 1, 2, 3]);
    expect(q.current?.itemId).toBe(2);
    q.move(q.index, 3);
    expect(q.current?.itemId).toBe(2);
    expect(q.index).toBe(3);
  });

  it('reports a single-album queue', () => {
    const q = make(2);
    expect(q.singleAlbum).toBe(true);
    q.addLast([t(9, 2)]);
    expect(q.singleAlbum).toBe(false);
  });
});

describe('replayGainFactor', () => {
  const g = { gain: -6, peak: 0.5, albumGain: -3, albumPeak: 0.9 };
  it('is 1 when off or untagged', () => {
    expect(replayGainFactor('off', 0, g, true)).toBe(1);
    expect(replayGainFactor('track', 6, { ...g, gain: null }, true)).toBe(1);
  });
  it('converts dB to a linear factor with the preamp', () => {
    expect(replayGainFactor('track', 0, { ...g, peak: null }, true)).toBeCloseTo(10 ** (-6 / 20));
    expect(replayGainFactor('track', 3, { ...g, peak: null }, true)).toBeCloseTo(10 ** (-3 / 20));
  });
  it('uses the album gain only for a single album, falling back to the track gain', () => {
    expect(replayGainFactor('album', 0, { ...g, albumPeak: null }, true)).toBeCloseTo(10 ** (-3 / 20));
    expect(replayGainFactor('album', 0, { ...g, peak: null }, false)).toBeCloseTo(10 ** (-6 / 20));
  });
  it('never lifts a peak past full scale', () => {
    expect(replayGainFactor('track', 12, { gain: 6, peak: 0.8, albumGain: null, albumPeak: null }, false)).toBeCloseTo(1.25);
  });
});
