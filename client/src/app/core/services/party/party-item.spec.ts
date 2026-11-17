import { describe, expect, it } from 'vitest';
import { itemIn, sameItem } from './party-item';

describe('party item identity', () => {
  it('tells two tracks of one album apart, and reads a row without an item as the same media and episode', () => {
    expect(sameItem({ mediaId: 1, itemId: 5 }, { mediaId: 1, itemId: 6 })).toBe(false);
    expect(sameItem({ mediaId: 1, episodeId: null, itemId: 5 }, { mediaId: 1, episodeId: undefined, itemId: 5 })).toBe(true);
    expect(sameItem({ mediaId: 1, itemId: 5 }, { mediaId: 1 })).toBe(true);
  });

  it('keeps the episode key and ignores absent itemId as before', () => {
    expect(sameItem({ mediaId: 2, episodeId: 20 }, { mediaId: 2, episodeId: 20, itemId: null })).toBe(true);
    expect(sameItem({ mediaId: 2, episodeId: 20 }, { mediaId: 2, episodeId: 21 })).toBe(false);
  });

  it('sends itemId only for a track', () => {
    expect(itemIn({ mediaId: 1, itemId: 5, episodeId: null })).toEqual({ mediaId: 1, itemId: 5 });
    expect(itemIn({ mediaId: 2, episodeId: 20, mediaFileId: 9 })).toEqual({ mediaId: 2, episodeId: 20, mediaFileId: 9 });
  });
});
