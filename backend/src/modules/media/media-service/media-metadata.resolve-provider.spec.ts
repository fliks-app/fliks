import { MediaMetadataService } from './media-metadata.service';

/**
 * resolveProviderForMedia's fallback step (no season/media/library override,
 * no direct tmdbId/tvdbId): an imdb-only media passes hasProviderId() but
 * used to fall straight to the "no provider ID" throw. It must first try the
 * TMDB imdb cross-reference, same as the tvdb/tmdb direct-match paths above it.
 */
describe('MediaMetadataService.resolveProviderForMedia — imdb-only fallback', () => {
  function harness() {
    const mediaRepo = { update: jest.fn(() => Promise.resolve({})) };
    const tmdb = {
      findByExternalId: jest.fn(() =>
        Promise.resolve({ id: '603', mediaType: 'movie' as const }),
      ),
    };
    const providerRegistry = {
      isAvailable: jest.fn(() => true),
      get: jest.fn(),
    };

    const service = Object.create(MediaMetadataService.prototype) as MediaMetadataService;
    Object.assign(service, {
      mediaRepo,
      tmdb,
      providerRegistry,
      log: { log: jest.fn(), warn: jest.fn() },
      loadLibraryOverride: jest.fn(() => Promise.resolve(undefined)),
    });
    return { service, mediaRepo, tmdb };
  }

  it('cross-references imdbId to a tmdbId instead of throwing', async () => {
    const { service, mediaRepo, tmdb } = harness();
    const media = {
      id: 5,
      title: 'Quiet Harbour',
      tmdbId: null,
      tvdbId: null,
      imdbId: 'tt1234567',
      libraryId: null,
      preferredProvider: null,
    };

    const result = await (
      service as unknown as {
        resolveProviderForMedia: (m: unknown) => Promise<{ provider: unknown; externalId: string }>;
      }
    ).resolveProviderForMedia(media);

    expect(tmdb.findByExternalId).toHaveBeenCalledWith('imdb', 'tt1234567', undefined);
    expect(result).toEqual({ provider: tmdb, externalId: '603' });
    expect(mediaRepo.update).toHaveBeenCalledWith(5, { tmdbId: 603 });
  });
});
