import { MediaImportService } from './media-import.service';
import { MediaType, MediaStatus } from '../../../common/enums';

describe('MediaImportService.createUnmatched', () => {
  function makeService(imageService: Record<string, jest.Mock> = {}) {
    const saved: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const mediaRepo = {
      create: jest.fn((m: any) => m),
      save: jest.fn(async (m: any) => {
        saved.push(m);
        return { id: 1, ...m };
      }),
      update: jest.fn(async (id: number, m: any) => {
        updates.push({ id, ...m });
      }),
      findOne: jest.fn().mockResolvedValue({ id: 1, title: 'Sample Movie' }),
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
      { storeFromDisk: jest.fn(), ...imageService } as any,
    );
    return { svc, mediaRepo, saved, updates, emitDomain };
  }

  it('creates an unmonitored, released title with no provider id', async () => {
    const { svc, saved, emitDomain } = makeService();
    const media = await svc.createUnmatched({
      title: 'Sample Movie',
      year: 2009,
      type: MediaType.MOVIE,
      libraryId: 3,
      folderName: 'Sample Movie (2009)',
    });

    expect(saved[0]).toMatchObject({
      title: 'Sample Movie',
      originalTitle: 'Sample Movie',
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

  it('fills empty fields from the nfo but never overrides a real title', async () => {
    const { svc, saved } = makeService();
    await svc.createUnmatched({
      title: 'Sample Movie 2',
      type: MediaType.MOVIE,
      libraryId: 3,
      folderName: 'Sample Movie 2 (2011)',
      nfo: {
        title: 'Sample Movie 2 Extended',
        originalTitle: 'Sample Movie 2 Original',
        year: 2011,
        plot: 'A tale of a meadow.',
        genres: ['Drama'],
        runtime: 100,
        rating: 7.4,
        premiered: '2011-03-02',
      },
    });

    expect(saved[0]).toMatchObject({
      title: 'Sample Movie 2',
      originalTitle: 'Sample Movie 2 Original',
      year: 2011,
      overview: 'A tale of a meadow.',
      genres: ['Drama'],
      runtime: 100,
      rating: 7.4,
      releaseDate: '2011-03-02',
    });
  });

  it('uses the nfo title when the guess is just the folder name', async () => {
    const { svc, saved } = makeService();
    await svc.createUnmatched({
      title: 'Sample Movie 2 (2011)',
      type: MediaType.MOVIE,
      libraryId: 3,
      folderName: 'Sample Movie 2 (2011)',
      nfo: { title: 'Sample Movie 2' },
    });

    expect(saved[0].title).toBe('Sample Movie 2');
    expect(saved[0].originalTitle).toBe('Sample Movie 2');
  });

  it('stores sibling artwork and writes the local image urls', async () => {
    const storeFromDisk = jest
      .fn()
      .mockImplementation((_p: string, _t: string, _id: number, variant: string) =>
        Promise.resolve(`/api/images/media/1/${variant}?v=abcdef12`),
      );
    const { svc, updates } = makeService({ storeFromDisk });
    await svc.createUnmatched({
      title: 'Sample Movie',
      type: MediaType.MOVIE,
      libraryId: 3,
      folderName: 'Sample Movie (2009)',
      artwork: { poster: '/media/Sample Movie (2009)/poster.jpg', fanart: '/media/Sample Movie (2009)/fanart.jpg' },
    });

    expect(storeFromDisk).toHaveBeenCalledWith(
      '/media/Sample Movie (2009)/poster.jpg',
      'media',
      1,
      'poster',
    );
    expect(storeFromDisk).toHaveBeenCalledWith(
      '/media/Sample Movie (2009)/fanart.jpg',
      'media',
      1,
      'fanart',
    );
    expect(updates[0]).toMatchObject({
      id: 1,
      posterUrl: '/api/images/media/1/poster?v=abcdef12',
      fanartUrl: '/api/images/media/1/fanart?v=abcdef12',
    });
  });

  it('does not fail the import when storing artwork throws', async () => {
    const storeFromDisk = jest.fn().mockRejectedValue(new Error('disk error'));
    const { svc, saved } = makeService({ storeFromDisk });

    await expect(
      svc.createUnmatched({
        title: 'Sample Movie',
        type: MediaType.MOVIE,
        libraryId: 3,
        folderName: 'Sample Movie (2009)',
        artwork: { poster: '/media/Sample Movie (2009)/poster.jpg' },
      }),
    ).resolves.toBeDefined();
    expect(saved).toHaveLength(1);
  });
});
