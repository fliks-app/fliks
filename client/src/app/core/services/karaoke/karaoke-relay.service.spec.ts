import { describe, expect, it } from 'vitest';
import { encodeBatch } from './pitch-frames';
import { decodeRelayed } from './karaoke-relay.service';

describe('decodeRelayed', () => {
  it('reads the singer the server stamped and the frames', () => {
    const data = JSON.stringify({ ...JSON.parse(encodeBatch([{ t: 10, midi: 60.2 }, { t: 30, midi: null }])), u: 7 });
    expect(decodeRelayed(data)).toEqual({ userId: 7, frames: [{ t: 10, midi: 60.2 }, { t: 30, midi: null }] });
  });

  it('drops a batch with no singer, no frames or no text', () => {
    expect(decodeRelayed(encodeBatch([{ t: 1, midi: 60 }]))).toBeNull();
    expect(decodeRelayed(JSON.stringify({ k: 'pf', u: 1, t: [], m: [] }))).toBeNull();
    expect(decodeRelayed(42)).toBeNull();
    expect(decodeRelayed('nope')).toBeNull();
  });
});
