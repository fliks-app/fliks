import { TmdbProvider } from './tmdb.provider';
import { TvdbProvider } from './tvdb.provider';

/**
 * Both providers used to walk seasons (TMDB) and episode translations (TVDB) one
 * request at a time, which is what made adding a long series take seconds.
 */
describe('Season fan-out is concurrent and order-stable', () => {
  function tmdbHarness(opts: { failSeason?: number } = {}) {
    let inFlight = 0;
    let peak = 0;
    const provider = Object.create(TmdbProvider.prototype) as TmdbProvider;
    Object.assign(provider, {
      metaLang: { resolve: () => Promise.resolve({ tmdbLocale: 'en-US' }) },
      logger: { warn: jest.fn() },
      client: {
        get: async (url: string) => {
          const season = /\/season\/(\d+)$/.exec(url);
          if (!season) {
            return {
              data: {
                seasons: [0, 1, 2, 3, 4, 5].map((n) => ({
                  season_number: n,
                  episode_count: n + 1,
                })),
              },
            };
          }
          const n = Number(season[1]);
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          if (n === opts.failSeason) throw new Error('boom');
          return {
            data: {
              season_number: n,
              episodes: [{ episode_number: 1, name: 'E1' }],
            },
          };
        },
      },
    });
    return { provider, peak: () => peak };
  }

  it('fetches seasons in parallel and keeps them in order', async () => {
    const { provider, peak } = tmdbHarness();

    const seasons = await provider.getTvShowSeasons('42');

    expect(seasons.map((s) => s.seasonNumber)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak()).toBeGreaterThan(1);
  });

  it('drops a season the provider refuses without losing the others', async () => {
    const { provider } = tmdbHarness({ failSeason: 3 });

    const seasons = await provider.getTvShowSeasons('42');

    expect(seasons.map((s) => s.seasonNumber)).toEqual([0, 1, 2, 4, 5]);
  });

  it('answers TMDB season stubs in one call, specials included', async () => {
    const { provider } = tmdbHarness();
    const calls: string[] = [];
    (provider as any).client.get = async (url: string) => {
      calls.push(url);
      return {
        data: { seasons: [{ season_number: 0, episode_count: 3 }] },
      };
    };

    const stubs = await provider.getSeasonStubs('42');

    expect(stubs).toEqual([{ seasonNumber: 0, episodeCount: 3 }]);
    expect(calls).toEqual(['/tv/42']);
  });

  it('fetches TVDB episode translations in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = Object.create(TvdbProvider.prototype) as TvdbProvider;
    const episodes = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: n,
      number: n,
      seasonNumber: 1,
      name: `E${n}`,
      overview: '',
      aired: '2025-01-01',
      runtime: 20,
      image: null,
      nameTranslations: ['fra'],
      overviewTranslations: ['fra'],
    }));
    Object.assign(provider, {
      metaLang: { resolve: () => Promise.resolve({ tvdbCode: 'fra' }) },
      ensureAuth: () => Promise.resolve(),
      client: {
        get: async (url: string) => {
          if (url.endsWith('/episodes/default')) {
            return { data: { data: { episodes } } };
          }
          if (url.endsWith('/extended')) {
            return { data: { data: { seasons: [] } } };
          }
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { data: { data: { name: 'Titre', overview: 'Résumé' } } };
        },
      },
    });

    const seasons = await provider.getTvShowSeasons('42');

    expect(seasons[0].episodes.map((e) => e.title)).toEqual(
      new Array(6).fill('Titre'),
    );
    expect(peak).toBeGreaterThan(1);
  });

  it('answers TVDB season stubs without fetching translations', async () => {
    const provider = Object.create(TvdbProvider.prototype) as TvdbProvider;
    const calls: string[] = [];
    Object.assign(provider, {
      ensureAuth: () => Promise.resolve(),
      client: {
        get: async (url: string) => {
          calls.push(url);
          return {
            data: {
              data: {
                episodes: [
                  { id: 1, number: 1, seasonNumber: 0 },
                  { id: 2, number: 1, seasonNumber: 1 },
                  { id: 3, number: 2, seasonNumber: 1 },
                ],
              },
            },
          };
        },
      },
    });

    const stubs = await provider.getSeasonStubs('42');

    expect(stubs).toEqual([
      { seasonNumber: 0, episodeCount: 1 },
      { seasonNumber: 1, episodeCount: 2 },
    ]);
    expect(calls.some((u) => u.includes('/translations/'))).toBe(false);
  });
});
