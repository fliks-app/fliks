import { MediaMetadataService } from './media-metadata.service';
import { MediaType } from '../../../common/enums';

type ProviderSeason = {
  seasonNumber: number;
  episodes: { episodeNumber: number }[];
};

/**
 * A media that once read another provider keeps episodes the current one does not have, and
 * the season becomes a mix of both — one provider's episode list with the other's titles.
 * The refresh drops that surplus, but only for a season the provider actually answered for.
 */
describe('MediaMetadataService.refreshSeriesEpisodes — stale episodes', () => {
  function harness(opts: {
    providerSeasons: ProviderSeason[];
    dbSeasons: {
      id: number;
      seasonNumber: number;
      preferredProvider?: string | null;
      episodes: { id: number; episodeNumber: number }[];
    }[];
  }) {
    const removedEpisodes: number[] = [];
    const seasonRepo = {
      find: jest.fn(() => Promise.resolve(opts.dbSeasons)),
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: Record<string, unknown>) =>
        Promise.resolve({ id: 900, ...v }),
      ),
    };
    const episodeRepo = {
      remove: jest.fn((eps: { id: number }[]) => {
        eps.forEach((e) => removedEpisodes.push(e.id));
        return Promise.resolve(eps);
      }),
    };

    const service = Object.create(
      MediaMetadataService.prototype,
    ) as MediaMetadataService;
    Object.assign(service, {
      seasonRepo,
      episodeRepo,
      log: { log: jest.fn(), warn: jest.fn() },
      loadLibraryOverride: jest.fn(() => Promise.resolve(undefined)),
      resolveProviderForMedia: jest.fn(() =>
        Promise.resolve({
          provider: {
            name: 'tvdb',
            getTvShowSeasons: () => Promise.resolve(opts.providerSeasons),
          },
          externalId: '42',
        }),
      ),
      // The upsert itself is covered by its own callers; only the prune is under test.
      applySeasonDetails: jest.fn(() => Promise.resolve({ insertedCount: 0 })),
    });
    return { service, removedEpisodes };
  }

  const media = { id: 7, type: MediaType.SERIES, title: 'A series' } as never;
  const eps = (...numbers: number[]) =>
    numbers.map((n) => ({ id: 100 + n, episodeNumber: n }));

  it('VERDICT: drops an episode the provider no longer lists', async () => {
    const { service, removedEpisodes } = harness({
      providerSeasons: [
        {
          seasonNumber: 1,
          episodes: [{ episodeNumber: 1 }, { episodeNumber: 2 }],
        },
      ],
      dbSeasons: [{ id: 1, seasonNumber: 1, episodes: eps(1, 2, 3) }],
    });

    await service.refreshSeriesEpisodes(media);

    expect(removedEpisodes).toEqual([103]);
  });

  it('keeps everything when the provider lists no episode for the season', async () => {
    const { service, removedEpisodes } = harness({
      providerSeasons: [{ seasonNumber: 1, episodes: [] }],
      dbSeasons: [{ id: 1, seasonNumber: 1, episodes: eps(1, 2) }],
    });

    await service.refreshSeriesEpisodes(media);

    expect(removedEpisodes).toEqual([]);
  });

  it('VERDICT: leaves a season the provider never answered for untouched', async () => {
    const { service, removedEpisodes } = harness({
      providerSeasons: [{ seasonNumber: 1, episodes: [{ episodeNumber: 1 }] }],
      dbSeasons: [
        { id: 1, seasonNumber: 1, episodes: eps(1) },
        { id: 2, seasonNumber: 2, episodes: eps(1, 2) },
      ],
    });

    await service.refreshSeriesEpisodes(media);

    expect(removedEpisodes).toEqual([]);
  });
});
