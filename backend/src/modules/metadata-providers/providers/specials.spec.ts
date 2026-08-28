import { TmdbProvider } from './tmdb.provider';
import { TvdbProvider } from './tvdb.provider';

/** Both providers used to drop season 0, so a special could never be matched to a file. */
describe('Season 0 reaches the caller', () => {
  it('VERDICT: TVDB returns the specials season', async () => {
    const provider = Object.create(TvdbProvider.prototype) as TvdbProvider;
    const episode = (id: number, seasonNumber: number, number: number) => ({
      id,
      number,
      seasonNumber,
      name: `E${number}`,
      overview: '',
      aired: '2025-01-01',
      runtime: 20,
      image: null,
      nameTranslations: [],
      overviewTranslations: [],
    });
    Object.assign(provider, {
      metaLang: { resolve: () => Promise.resolve({ tvdbCode: 'eng' }) },
      ensureAuth: () => Promise.resolve(),
      client: {
        get: (url: string) =>
          url.endsWith('/episodes/default')
            ? Promise.resolve({
                data: {
                  data: { episodes: [episode(1, 0, 1), episode(2, 1, 1)] },
                },
              })
            : Promise.resolve({ data: { data: { seasons: [] } } }),
      },
    });

    const seasons = await provider.getTvShowSeasons('42');

    expect(seasons.map((s) => s.seasonNumber)).toEqual([0, 1]);
  });

  it('VERDICT: TMDB returns the specials season', async () => {
    const provider = Object.create(TmdbProvider.prototype) as TmdbProvider;
    Object.assign(provider, {
      metaLang: { resolve: () => Promise.resolve({ tmdbLocale: 'en-US' }) },
      logger: { warn: jest.fn() },
      client: {
        get: (url: string) => {
          const season = /\/season\/(\d+)$/.exec(url);
          if (season) {
            return Promise.resolve({
              data: {
                season_number: Number(season[1]),
                episodes: [{ episode_number: 1, name: 'E1' }],
              },
            });
          }
          return Promise.resolve({
            data: { seasons: [{ season_number: 0 }, { season_number: 1 }] },
          });
        },
      },
    });

    const seasons = await provider.getTvShowSeasons('42');

    expect(seasons.map((s) => s.seasonNumber)).toEqual([0, 1]);
  });
});
