import { ConflictException, BadRequestException } from '@nestjs/common';
import { MediaMetadataService } from './media-metadata.service';
import { MediaType } from '../../../common/enums';

/**
 * Identification re-points a media at another work. What must survive is the
 * matched rows: an episode whose numbers exist in the new work keeps its id, and
 * with it the files, playback states, markers, likes and playlist entries that
 * reference it. Only the surplus is dropped.
 */
describe('MediaMetadataService.identify', () => {
  function harness(opts: {
    media: Record<string, unknown>;
    clash?: Record<string, unknown> | null;
    seasons?: { seasonNumber: number; episodes: { id: number; episodeNumber: number }[] }[];
    providerSeasons?: { seasonNumber: number; episodes: { episodeNumber: number }[] }[];
  }) {
    const updates: Record<string, unknown>[] = [];
    const removedSeasons: number[] = [];
    const removedEpisodes: number[] = [];

    const mediaRepo = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('tmdbId' in where ? (opts.clash ?? null) : opts.media),
      ),
      update: jest.fn((_id: number, patch: Record<string, unknown>) => {
        updates.push(patch);
        return Promise.resolve({});
      }),
    };
    const seasonRepo = {
      find: jest.fn(() => Promise.resolve(opts.seasons ?? [])),
      remove: jest.fn((s: { seasonNumber: number }) => {
        removedSeasons.push(s.seasonNumber);
        return Promise.resolve(s);
      }),
    };
    const episodeRepo = {
      remove: jest.fn((eps: { id: number }[]) => {
        eps.forEach((e) => removedEpisodes.push(e.id));
        return Promise.resolve(eps);
      }),
    };

    const service = Object.create(MediaMetadataService.prototype) as MediaMetadataService;
    Object.assign(service, {
      mediaRepo,
      seasonRepo,
      episodeRepo,
      log: { log: jest.fn(), warn: jest.fn() },
      // the refresh itself is covered elsewhere; identify only orchestrates it
      refreshMetadata: jest.fn(() => Promise.resolve(opts.media)),
      resolveProviderForMedia: jest.fn(() =>
        Promise.resolve({
          provider: {
            getTvShowSeasons: () => Promise.resolve(opts.providerSeasons ?? []),
          },
          externalId: '42',
        }),
      ),
      loadLibraryOverride: jest.fn(() => Promise.resolve(undefined)),
    });
    return { service, updates, removedSeasons, removedEpisodes, mediaRepo };
  }

  const movie = { id: 1, type: MediaType.MOVIE, title: 'Old', tmdbId: 10 };

  it('refuses an empty target rather than refreshing against nothing', async () => {
    const { service } = harness({ media: movie });

    await expect(service.identify(1, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('VERDICT: refuses a TMDB id another title already holds, before touching the row', async () => {
    const { service, updates } = harness({
      media: movie,
      clash: { id: 99, title: 'Taken', tmdbId: 55 },
    });

    await expect(service.identify(1, { tmdbId: 55 })).rejects.toBeInstanceOf(ConflictException);
    expect(updates).toEqual([]); // the ids were never written
  });

  it('writes only the ids the caller supplied', async () => {
    const { service, updates } = harness({ media: movie });

    await service.identify(1, { tmdbId: 77, imdbId: 'tt7' });

    expect(updates).toEqual([{ tmdbId: 77, imdbId: 'tt7' }]);
  });

  it('leaves a movie alone past the refresh — no season work', async () => {
    const { service, removedSeasons, removedEpisodes } = harness({ media: movie });

    await service.identify(1, { tmdbId: 77 });

    expect(removedSeasons).toEqual([]);
    expect(removedEpisodes).toEqual([]);
  });

  it('VERDICT: drops the surplus of the old work and keeps what the new one has', async () => {
    const series = { id: 2, type: MediaType.SERIES, title: 'Old Show', tmdbId: 10 };
    const { service, removedSeasons, removedEpisodes } = harness({
      media: series,
      seasons: [
        { seasonNumber: 1, episodes: [{ id: 11, episodeNumber: 1 }, { id: 12, episodeNumber: 2 }] },
        { seasonNumber: 2, episodes: [{ id: 21, episodeNumber: 1 }] },
        { seasonNumber: 3, episodes: [{ id: 31, episodeNumber: 1 }] },
      ],
      // the new work has S01 (one episode only) and S02, but no S03
      providerSeasons: [
        { seasonNumber: 1, episodes: [{ episodeNumber: 1 }] },
        { seasonNumber: 2, episodes: [{ episodeNumber: 1 }] },
      ],
    });

    await service.identify(2, { tmdbId: 77 });

    expect(removedSeasons).toEqual([3]);
    expect(removedEpisodes).toEqual([12]); // S01E02 has no counterpart
    // S01E01 (11) and S02E01 (21) keep their rows, and everything pointing at them
    expect(removedEpisodes).not.toContain(11);
    expect(removedEpisodes).not.toContain(21);
  });
});
