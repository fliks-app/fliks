import { MetadataProvidersController } from './metadata-providers.controller';

/**
 * Re-identifying a media searches the provider that media is refreshed from.
 * Searching the global default instead returns works the library's provider has
 * never heard of, and the ids on them cannot identify anything.
 */
describe('MetadataProvidersController — which provider a search uses', () => {
  function harness(media: Record<string, unknown> | null) {
    const searched: (string | undefined)[] = [];
    const controller = Object.create(
      MetadataProvidersController.prototype,
    ) as MetadataProvidersController;
    Object.assign(controller, {
      mediaRepo: { findOne: jest.fn(() => Promise.resolve(media)) },
      searchWithFallback: jest.fn((name?: string) => {
        searched.push(name);
        return Promise.resolve([]);
      }),
      enrichWithExisting: jest.fn((r: unknown[]) => Promise.resolve(r)),
    });
    return { controller, searched };
  }

  it("VERDICT: falls back to the library's provider when the media has no override", async () => {
    const { controller, searched } = harness({
      id: 795,
      preferredProvider: null,
      library: { preferredProvider: 'tvdb' },
    });

    await controller.searchTv('a series', undefined, undefined, '795');

    expect(searched).toEqual(['tvdb']);
  });

  it("prefers the media's own override over its library's", async () => {
    const { controller, searched } = harness({
      id: 795,
      preferredProvider: 'tmdb',
      library: { preferredProvider: 'tvdb' },
    });

    await controller.searchTv('a series', undefined, undefined, '795');

    expect(searched).toEqual(['tmdb']);
  });

  it('lets an explicit provider win over both', async () => {
    const { controller, searched } = harness({
      id: 795,
      preferredProvider: 'tmdb',
      library: { preferredProvider: 'tvdb' },
    });

    await controller.searchTv('a series', undefined, 'tvdb', '795');

    expect(searched).toEqual(['tvdb']);
  });

  it('expresses no preference without a media id, or for one that is gone', async () => {
    const { controller, searched } = harness(null);

    await controller.searchMovie('a film');
    await controller.searchMovie('a film', undefined, undefined, '795');
    await controller.searchMovie('a film', undefined, undefined, 'not-a-number');

    expect(searched).toEqual([undefined, undefined, undefined]);
  });
});
