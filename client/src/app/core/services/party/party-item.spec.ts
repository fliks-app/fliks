import { describe, expect, it } from 'vitest';
import { itemIn, sameItem } from './party-item';

describe('party item identity', () => {
  it('tells two tracks of one album apart, and a track from the album row', () => {
    expect(sameItem({ mediaId: 1, itemId: 5 }, { mediaId: 1, itemId: 6 })).toBe(false);
    expect(sameItem({ mediaId: 1, episodeId: null, itemId: 5 }, { mediaId: 1, episodeId: undefined, itemId: 5 })).toBe(true);
    expect(sameItem({ mediaId: 1, itemId: 5 }, { mediaId: 1 })).toBe(false);
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
