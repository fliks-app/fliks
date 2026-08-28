import { MediaImportService } from './media-import.service';
import { MediaType } from '../../../common/enums';

/**
 * A season-scoped request must monitor only the seasons it asked for on a fresh
 * import; the rest import unmonitored so the auto-grab leaves them alone.
 */
describe('MediaImportService — season monitoring scope on import', () => {
  function makeService() {
    const created: { seasonNumber: number; monitored: boolean }[] = [];
    const seasonRepo = {
      create: jest.fn((s: any) => {
        created.push(s);
        return s;
      }),
      save: jest.fn(async (s: any) => ({ id: s.seasonNumber + 100, ...s })),
    };
    const mediaRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null) // existing-title check
        .mockResolvedValue({ id: 1 }), // reload after save
      create: jest.fn((m: any) => m),
      save: jest.fn(async (m: any) => ({ id: 1, ...m })),
    };
    const svc = new MediaImportService(
      mediaRepo as any,
      seasonRepo as any,
      {} as any,
      {} as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      {
        getTvShowDetails: jest
          .fn()
          .mockResolvedValue({ title: 'X', tmdbId: 42 }),
        getTvShowSeasons: jest
          .fn()
          .mockResolvedValue(
            [0, 1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n })),
          ),
      } as any,
      {} as any,
      { get: jest.fn().mockReturnValue('tmdb-key') } as any,
      {
        resolveQualityProfileIdForImport: jest.fn().mockResolvedValue(null),
        resolveLanguageProfileIdForImport: jest.fn().mockResolvedValue(null),
      } as any,
      {} as any,
      { applySeriesFolderFormat: jest.fn().mockReturnValue('folder') } as any,
      {
        downloadMediaImagesInBackground: jest.fn(),
        applySeasonDetails: jest.fn().mockResolvedValue(undefined),
        updateSearchVector: jest.fn().mockResolvedValue(undefined),
        persistMediaMetadataInBackground: jest.fn(),
      } as any,
      { onMediaImported: jest.fn().mockResolvedValue(undefined) } as any,
      { emitDomain: jest.fn() } as any,
    );
    jest.spyOn(svc as any, 'resolveImportTarget').mockResolvedValue({
      libraryId: 7,
      library: { metadataLanguage: null, metadataRegion: null },
    });
    return { svc, created };
  }

  const dto = { type: MediaType.SERIES, tmdbId: 42 } as any;

  const monitoredNumbers = (
    created: { seasonNumber: number; monitored: boolean }[],
  ) =>
    created
      .filter((s) => s.monitored)
      .map((s) => s.seasonNumber)
      .sort((a, b) => a - b);

  it('monitors only the requested seasons, leaving the rest unmonitored', async () => {
    const { svc, created } = makeService();
    await svc.importFromTmdb(dto, null, [1, 2, 3, 4]);
    expect(monitoredNumbers(created)).toEqual([1, 2, 3, 4]);
    expect(
      created
        .filter((s) => !s.monitored)
        .map((s) => s.seasonNumber)
        .sort((a, b) => a - b),
    ).toEqual([0, 5, 6]);
  });

  it('monitors every season but the specials when the scope is null (whole series / admin add)', async () => {
    const { svc, created } = makeService();
    await svc.importFromTmdb(dto, null, null);
    expect(monitoredNumbers(created)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('monitors every season but the specials when the scope is an empty array', async () => {
    const { svc, created } = makeService();
    await svc.importFromTmdb(dto, null, []);
    expect(monitoredNumbers(created)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /** Season 0 is only ever monitored on purpose, by number. */
  it('VERDICT: monitors the specials when the scope names season 0', async () => {
    const { svc, created } = makeService();
    await svc.importFromTmdb(dto, null, [0]);
    expect(monitoredNumbers(created)).toEqual([0]);
  });
});
