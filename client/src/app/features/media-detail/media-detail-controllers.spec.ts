import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import type { Episode, Media, Season } from '../../core/services/api/media.service';
import type { LikesApiService } from '../../core/services/api/likes-api.service';
import type { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { EpisodeViewController } from './episode-view-controller';
import { LikeController } from './like-controller';
import { WatchedController } from './watched-controller';

const ep = (id: number, episodeNumber: number, hasFile = true): Episode =>
  ({ id, episodeNumber, hasFile, title: `E${episodeNumber}`, monitored: true }) as Episode;
const season = (id: number, seasonNumber: number, episodes: Episode[]): Season =>
  ({ id, seasonNumber, episodes }) as Season;
const series = (seasons: Season[], files: { id: number; episodeId: number }[] = []): Media =>
  ({ id: 7, type: 'series', seasons, files }) as unknown as Media;

describe('WatchedController', () => {
  const m = series([season(1, 1, [ep(10, 1), ep(11, 2, false)]), season(2, 0, [ep(20, 1)])]);

  it('marks every downloaded episode of a non-special season when the series is toggled watched', () => {
    const c = new WatchedController({ media: () => m }, {} as StreamingApiService);
    c.episodeProgress.set({ 10: 30 });
    c.onSeriesToggled({ watched: true });
    expect([...c.episodeIds()]).toEqual([10]);
    expect(c.episodeProgress()).toEqual({});
    expect(c.seriesFullyWatched()).toBe(true);
    c.onSeriesToggled({ watched: false });
    expect(c.episodeIds().size).toBe(0);
  });

  it('flips an episode optimistically and puts it back when the call fails', async () => {
    const api = { toggleWatched: vi.fn().mockRejectedValue(new Error('x')) };
    const withFile = series([season(1, 1, [ep(10, 1)])], [{ id: 99, episodeId: 10 }]);
    const c = new WatchedController({ media: () => withFile }, api as unknown as StreamingApiService);
    await c.onToggleEpisodeWatched(7, ep(10, 1), true);
    expect(api.toggleWatched).toHaveBeenCalledWith(7, 99, 10);
    expect(c.episodeIds().has(10)).toBe(false);
  });
});

describe('LikeController', () => {
  function setup(api: Partial<LikesApiService>) {
    const media = signal<Media | null>({ id: 7, type: 'movie' } as Media);
    const full = {
      changed: signal(null),
      state: vi.fn().mockResolvedValue({ media: false, seasonIds: [], episodeIds: [] }),
      like: vi.fn().mockResolvedValue(undefined),
      unlike: vi.fn().mockResolvedValue(undefined),
      ...api,
    } as unknown as LikesApiService;
    const c = runInInjectionContext(TestBed.inject(Injector), () =>
      new LikeController({ media, episodeMode: () => false, focusedEpisode: () => null }, full),
    );
    return { c, api: full };
  }

  it('likes the title optimistically and reloads the state when the call fails', async () => {
    const { c, api } = setup({ like: vi.fn().mockRejectedValue(new Error('x')) });
    const pending = c.toggle();
    expect(c.state().media).toBe(true);
    await pending;
    expect(api.like).toHaveBeenCalledWith({ mediaId: 7 });
    await vi.waitFor(() => expect(api.state).toHaveBeenCalledWith(7, { force: true }));
  });

  it('tracks seasons and episodes separately', async () => {
    const { c, api } = setup({});
    await c.toggleSeason(3);
    await c.toggleEpisode(4);
    expect(c.seasonLiked(3)).toBe(true);
    expect(c.state().episodeIds).toEqual([4]);
    await c.toggleSeason(3);
    expect(api.unlike).toHaveBeenCalledWith({ mediaId: 7, seasonId: 3 });
  });
});

describe('EpisodeViewController.nextPlayEpisode', () => {
  const media = series(
    [season(1, 1, [ep(10, 1), ep(11, 2)]), season(2, 2, [ep(20, 1)])],
    [10, 11, 20].map((id) => ({ id: id * 10, episodeId: id })),
  );
  function setup(watched: number[], resume: { episodeId: number; mediaFileId: number } | null = null) {
    return new EpisodeViewController(
      {
        media: () => media,
        focusedEpisode: () => null,
        focusedSeason: () => null,
        selectedFileId: () => null,
        resumeInfo: () => resume as never,
      },
      { spoilers: {} as never, translate: {} as never, watchedEpisodeIds: signal(new Set(watched)) },
    );
  }

  it('prefers the resume target, then the first unwatched episode, then the first one', () => {
    expect(setup([10], { episodeId: 20, mediaFileId: 5 }).nextPlayEpisode()?.file.id).toBe(5);
    expect(setup([10]).nextPlayEpisodeId()).toBe(11);
    expect(setup([10, 11, 20]).nextPlayEpisodeId()).toBe(10);
    expect(setup([10]).resumeEpisodeLabel()).toBe('S01:E02 - E2');
  });
});
