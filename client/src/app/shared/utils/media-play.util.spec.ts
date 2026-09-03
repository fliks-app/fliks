import { describe, expect, it } from 'vitest';
import { Media } from '../../core/services/api/media.service';
import { buildSeriesQueueItems, resolveNextEpisodeItem } from './media-play.util';

/** S2 declared before S1, one special, and E2 with no file. */
const series = {
  id: 7,
  title: 'A series',
  type: 'series',
  fanartUrl: '/f.jpg',
  seasons: [
    { seasonNumber: 2, episodes: [{ id: 21, episodeNumber: 1, title: 'Third' }] },
    { seasonNumber: 0, episodes: [{ id: 90, episodeNumber: 1, title: 'Special' }] },
    {
      seasonNumber: 1,
      episodes: [
        { id: 11, episodeNumber: 1, title: 'First' },
        { id: 12, episodeNumber: 2, title: 'Missing file' },
        { id: 13, episodeNumber: 3, title: 'Second' },
      ],
    },
  ],
  files: [
    { id: 111, episodeId: 11 },
    { id: 113, episodeId: 13 },
    { id: 121, episodeId: 21 },
    { id: 190, episodeId: 90 },
  ],
} as unknown as Media;

describe('buildSeriesQueueItems', () => {
  it('orders by S/E, skips specials and episodes with no file', () => {
    expect(buildSeriesQueueItems(series).map((i) => i.episodeId)).toEqual([11, 13, 21]);
    expect(buildSeriesQueueItems(series)[0].episodeTitle).toBe('S1:E1 - First');
    expect(buildSeriesQueueItems({ id: 1, type: 'movie' } as Media)).toEqual([]);
  });
});

describe('resolveNextEpisodeItem', () => {
  it('crosses the season boundary and stops on the last episode', () => {
    expect(resolveNextEpisodeItem(series, 11)?.mediaFileId).toBe(113);
    expect(resolveNextEpisodeItem(series, 13)?.episodeId).toBe(21);
    expect(resolveNextEpisodeItem(series, 21)).toBeNull();
    // Not queue-able itself, so it has no place to advance from.
    expect(resolveNextEpisodeItem(series, 12)).toBeNull();
  });
});
