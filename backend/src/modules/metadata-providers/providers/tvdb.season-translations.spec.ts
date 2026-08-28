import { TvdbProvider } from './tvdb.provider';

/**
 * TVDB advertises a translation per field: an episode with a translated overview but no
 * translated name answers `{ name: '' }`. Passing that empty name on left the previous
 * provider's title in place (the metadata refresh only overwrites a non-empty value), so a
 * season ended up with one provider's episodes and another's titles.
 */
describe('TvdbProvider.getTvShowSeasons — an empty translated name', () => {
  function harness(translation: { name: string; overview: string }) {
    const provider = Object.create(TvdbProvider.prototype) as TvdbProvider;
    Object.assign(provider, {
      metaLang: { resolve: () => Promise.resolve({ tvdbCode: 'fra' }) },
      ensureAuth: () => Promise.resolve(),
      client: {
        get: (url: string) => {
          if (url.endsWith('/episodes/default')) {
            return Promise.resolve({
              data: {
                data: {
                  episodes: [
                    {
                      id: 55,
                      number: 1,
                      seasonNumber: 1,
                      name: 'Origin Title',
                      overview: 'Origin overview.',
                      aired: '2025-06-11',
                      runtime: 23,
                      image: null,
                      nameTranslations: [],
                      overviewTranslations: ['fra'],
                    },
                  ],
                },
              },
            });
          }
          if (url.endsWith('/extended')) {
            return Promise.resolve({ data: { data: { seasons: [] } } });
          }
          return Promise.resolve({ data: { data: translation } });
        },
      },
    });
    return provider;
  }

  it('VERDICT: keeps the origin-language name when the translation carries none', async () => {
    const seasons = await harness({
      name: '',
      overview: 'Résumé traduit.',
    }).getTvShowSeasons('42');

    expect(seasons[0].episodes[0].title).toBe('Origin Title');
    expect(seasons[0].episodes[0].overview).toBe('Résumé traduit.');
  });

  it('still prefers a real translated name', async () => {
    const seasons = await harness({
      name: 'Titre traduit',
      overview: 'Résumé traduit.',
    }).getTvShowSeasons('42');

    expect(seasons[0].episodes[0].title).toBe('Titre traduit');
  });
});
