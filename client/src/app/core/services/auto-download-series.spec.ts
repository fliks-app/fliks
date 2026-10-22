import { pickNextEpisodes } from './auto-download-series';
import type { Media } from './api/media.service';

const ep = (id: number, episodeNumber: number, hasFile = true) => ({ id, episodeNumber, hasFile });
const media = {
  seasons: [
    { seasonNumber: 2, episodes: [ep(21, 2), ep(20, 1)] },
    { seasonNumber: 0, episodes: [ep(1, 1)] },
    { seasonNumber: 1, episodes: [ep(12, 2), ep(11, 1), ep(13, 3, false)] },
  ],
  files: [{ id: 900, episodeId: 12 }],
} as unknown as Media;

describe('pickNextEpisodes', () => {
  it('orders by season then episode, skips specials and file-less episodes', () => {
    const ids = pickNextEpisodes(media, new Set(), 10).map((p) => p.episode.id);
    expect(ids).toEqual([11, 12, 20, 21]);
  });
  it('drops watched episodes and takes the first N', () => {
    expect(pickNextEpisodes(media, new Set([11]), 2).map((p) => p.episode.id)).toEqual([12, 20]);
  });
  it('carries the file id when known', () => {
    expect(pickNextEpisodes(media, new Set(), 2)[1].mediaFileId).toBe(900);
  });
});
