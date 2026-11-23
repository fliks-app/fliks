import { describe, expect, it } from 'vitest';
import { Media } from '../../core/services/api/media.service';
import { buildSeriesQueueItems, episodeCode, episodeLabel, nextUp, resolveNextEpisodeItem } from './media-play.util';

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

describe('episodeLabel', () => {
  const m = { seasons: [{ seasonNumber: 1, episodes: [{ id: 10, episodeNumber: 2, title: 'Pilot' }, { id: 11, episodeNumber: 3, title: null }] }] } as never;

  it('reads like the player header, with or without a title', () => {
    expect(episodeLabel(m, 10)).toBe('S1:E2 - Pilot');
    expect(episodeLabel(m, 11)).toBe('S1:E3');
    expect(episodeLabel(m, 99)).toBeNull();
  });
});

describe('nextUp', () => {
  const ep = (id: number, episodeNumber: number, hasFile = true) => ({ id, episodeNumber, hasFile, title: `E${episodeNumber}` });
  const m = (seasons: unknown[], fileEpisodes: number[]) =>
    ({ id: 7, type: 'series', seasons, files: fileEpisodes.map((id) => ({ id: id * 10, episodeId: id })) }) as unknown as Media;
  const media = m(
    [
      { id: 2, seasonNumber: 2, episodes: [ep(20, 1)] },
      { id: 1, seasonNumber: 1, episodes: [ep(11, 2), ep(10, 1)] },
      { id: 0, seasonNumber: 0, episodes: [ep(99, 1)] },
    ],
    [10, 11, 20, 99],
  );
  const id = (n: ReturnType<typeof nextUp>) => n?.episode.id;

  it('resumes the episode in progress with its file', () => {
    const n = nextUp(media, { episodeId: 20, mediaFileId: 5 } as never, new Set([10]));
    expect([id(n), n?.file.id]).toEqual([20, 5]);
    expect(episodeCode(n!)).toBe('S02E01');
  });

  it('else takes the first unwatched episode with a file, in season and episode order, skipping specials', () => {
    expect(id(nextUp(media, null, new Set([10])))).toBe(11);
  });

  it('else starts again from the first episode when everything is watched', () => {
    expect(id(nextUp(media, null, new Set([10, 11, 20])))).toBe(10);
  });

  it('is null with no episode on disk, and for a movie', () => {
    expect(nextUp(m([{ id: 1, seasonNumber: 1, episodes: [ep(10, 1, false)] }], []), null, new Set())).toBeNull();
    expect(nextUp({ id: 1, type: 'movie' } as Media, null, new Set())).toBeNull();
  });
});
