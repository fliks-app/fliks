import { MediaImportService } from './media-import.service';
import { MediaType } from '../../../common/enums';

/**
 * The search answers from whichever provider is configured globally and the library is picked
 * afterwards, so importing what the search returned wrote TMDB rows into a TVDB library: one
 * provider's episode list with the other's titles.
 */
describe('MediaImportService — the destination library owns the provider', () => {
  function makeService(opts: {
    preferredProvider: string | null;
    tvdbAvailable?: boolean;
    tmdbDetails?: Record<string, unknown>;
  }) {
    const seasonsFrom: string[] = [];
    const warnings: string[] = [];
    const seasonRepo = {
      create: jest.fn((s: unknown) => s),
      save: jest.fn(async (s: { seasonNumber: number }) => ({
        id: s.seasonNumber + 100,
        ...s,
      })),
    };
    const saved: Record<string, unknown>[] = [];
    const mediaRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 1 }),
      create: jest.fn((m: Record<string, unknown>) => m),
      save: jest.fn(async (m: Record<string, unknown>) => {
        saved.push(m);
        return { id: 1, ...m };
      }),
    };
    const tmdb = {
      getTvShowDetails: jest.fn().mockResolvedValue(
        opts.tmdbDetails ?? {
          title: 'A series',
          tmdbId: 42,
          tvdbId: 777,
          imdbId: 'tt1',
        },
      ),
      getTvShowSeasons: jest.fn(async () => {
        seasonsFrom.push('tmdb');
        return [{ seasonNumber: 1 }, { seasonNumber: 2 }];
      }),
    };
    const tvdb = {
      name: 'tvdb',
      getTvShowDetails: jest
        .fn()
        .mockResolvedValue({ title: 'A series', tmdbId: 0, tvdbId: 777 }),
      getTvShowSeasons: jest.fn(async () => {
        seasonsFrom.push('tvdb');
        return [{ seasonNumber: 1 }];
      }),
    };
    const registry = {
      isAvailable: jest.fn(() => opts.tvdbAvailable ?? true),
      get: jest.fn(() => tvdb),
    };

    const svc = new MediaImportService(
      mediaRepo as never,
      seasonRepo as never,
      {} as never,
      {} as never,
      { query: jest.fn().mockResolvedValue([]) } as never,
      { name: 'tmdb', ...tmdb } as never,
      registry as never,
      { get: jest.fn().mockReturnValue('tmdb-key') } as never,
      {
        resolveQualityProfileIdForImport: jest.fn().mockResolvedValue(null),
        resolveLanguageProfileIdForImport: jest.fn().mockResolvedValue(null),
      } as never,
      {} as never,
      { applySeriesFolderFormat: jest.fn().mockReturnValue('folder') } as never,
      {
        downloadMediaImagesInBackground: jest.fn(),
        applySeasonDetails: jest.fn().mockResolvedValue(undefined),
        updateSearchVector: jest.fn().mockResolvedValue(undefined),
        persistMediaMetadataInBackground: jest.fn(),
      } as never,
      { onMediaImported: jest.fn().mockResolvedValue(undefined) } as never,
      { emitDomain: jest.fn() } as never,
    );
    Object.assign(svc, {
      log: { log: jest.fn(), warn: jest.fn((m: string) => warnings.push(m)) },
    });
    jest
      .spyOn(
        svc as never as { resolveImportTarget: unknown },
        'resolveImportTarget' as never,
      )
      .mockResolvedValue({
        libraryId: 7,
        library: {
          metadataLanguage: null,
          metadataRegion: null,
          preferredProvider: opts.preferredProvider,
        },
      } as never);
    return { svc, seasonsFrom, saved, warnings, tvdb };
  }

  const dto = { type: MediaType.SERIES, tmdbId: 42 } as never;

  it('VERDICT: reads a TMDB hit from TVDB when the library prefers it, keeping both ids', async () => {
    const { svc, seasonsFrom, saved, tvdb } = makeService({
      preferredProvider: 'tvdb',
    });

    await svc.importFromTmdb(dto);

    expect(tvdb.getTvShowDetails).toHaveBeenCalledWith(
      '777',
      expect.anything(),
    );
    expect(seasonsFrom).toEqual(['tvdb']);
    expect(saved[0]).toMatchObject({ tmdbId: 42, tvdbId: 777 });
  });

  it('stays on the provider that found the title when the library has no preference', async () => {
    const { svc, seasonsFrom } = makeService({ preferredProvider: null });

    await svc.importFromTmdb(dto);

    expect(seasonsFrom).toEqual(['tmdb']);
  });

  it('falls back with a warning when the preferred provider is not configured', async () => {
    const { svc, seasonsFrom, warnings } = makeService({
      preferredProvider: 'tvdb',
      tvdbAvailable: false,
    });

    await svc.importFromTmdb(dto);

    expect(seasonsFrom).toEqual(['tmdb']);
    expect(warnings[0]).toContain('not available');
  });

  it('VERDICT: falls back when the work has no id on the preferred provider', async () => {
    const { svc, seasonsFrom, warnings } = makeService({
      preferredProvider: 'tvdb',
      tmdbDetails: {
        title: 'A series',
        tmdbId: 42,
        tvdbId: null,
        imdbId: null,
      },
    });

    await svc.importFromTmdb(dto);

    expect(seasonsFrom).toEqual(['tmdb']);
    expect(warnings[0]).toContain('cross-reference failed');
  });
});
