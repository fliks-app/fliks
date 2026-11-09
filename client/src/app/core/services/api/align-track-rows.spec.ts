import { describe, expect, it } from 'vitest';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import { alignTrackRows } from './music-api.service';

const row = (itemId: number) => ({ itemId }) as MusicTrackRequest;

describe('alignTrackRows', () => {
  it('keeps the wire index of each row and skips ids without a row', () => {
    const out = alignTrackRows([1, 2, 3, 1], [row(1), row(3), row(1)]);
    expect(out.map((a) => a.wireIndex)).toEqual([0, 2, 3]);
  });
});
