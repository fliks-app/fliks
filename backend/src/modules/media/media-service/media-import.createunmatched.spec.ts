import { MediaImportService } from './media-import.service';
import { MediaType, MediaStatus } from '../../../common/enums';

describe('MediaImportService.createUnmatched', () => {
  function makeService() {
    const saved: Record<string, unknown>[] = [];
    const mediaRepo = {
      create: jest.fn((m: any) => m),
      save: jest.fn(async (m: any) => {
        saved.push(m);
        return { id: 1, ...m };
      }),
      findOne: jest.fn().mockResolvedValue({ id: 1, title: 'Quiet Harbour' }),
    };
    const emitDomain = jest.fn();
    const svc = new MediaImportService(
      mediaRepo as any,
      {} as any, // seasonRepo
      {} as any, // episodeRepo
      {} as any, // libraryRepo
      {} as any, // dataSource
      {} as any, // tmdb
      {} as any, // providerRegistry
      {} as any, // config
      {
        resolveQualityProfileIdForImport: jest.fn().mockResolvedValue(null),
        resolveLanguageProfileIdForImport: jest.fn().mockResolvedValue(null),
      } as any,
      {} as any, // libraries
      {} as any, // naming
      { updateSearchVector: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any, // requestLifecycle
      { emitDomain } as any,
    );
    return { svc, mediaRepo, saved, emitDomain };
  }

  it('creates an unmonitored, released title with no provider id', async () => {
    const { svc, saved, emitDomain } = makeService();
    const media = await svc.createUnmatched({
      title: 'Quiet Harbour',
      year: 2009,
      type: MediaType.MOVIE,
      libraryId: 3,
      folderName: 'Quiet Harbour (2009)',
    });

    expect(saved[0]).toMatchObject({
      title: 'Quiet Harbour',
      originalTitle: 'Quiet Harbour',
      monitored: false,
      status: MediaStatus.RELEASED,
    });
    expect(saved[0]).not.toHaveProperty('tmdbId');
    expect(saved[0]).not.toHaveProperty('tvdbId');
    expect(saved[0]).not.toHaveProperty('imdbId');
    expect(emitDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'media.imported',
        tmdbId: null,
        mediaType: MediaType.MOVIE,
      }),
    );
    expect(media.id).toBe(1);
  });
});
