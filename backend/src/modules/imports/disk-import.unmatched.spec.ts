import { BadRequestException } from '@nestjs/common';
import { DiskImportService } from './disk-import.service';
import { RelinkOrphansDto } from './dto/relink-orphans.dto';
import { MediaType } from '../../common/enums';
import { findLocalArtwork } from './local-artwork.util';

jest.mock('./local-artwork.util');
const mockedFindLocalArtwork = jest.mocked(findLocalArtwork);

const library = {
  id: 1,
  name: 'Movies',
  path: '/media',
  mediaTypes: [MediaType.MOVIE, MediaType.SERIES],
};

const dto = (overrides: Partial<RelinkOrphansDto> = {}): RelinkOrphansDto =>
  ({
    libraryId: 1,
    type: MediaType.MOVIE,
    folderName: 'Sample Movie (2009)',
    title: 'Sample Movie',
    year: 2009,
    files: [{ filePath: '/media/Sample Movie (2009)/Sample.Movie.2009.1080p.mkv' }],
    ...overrides,
  }) as RelinkOrphansDto;

function makeService() {
  const mediaRepo = { findOne: jest.fn(), find: jest.fn(), update: jest.fn(), delete: jest.fn() };
  const fileRepo = { count: jest.fn().mockResolvedValue(0) };
  const mediaService = {
    importMedia: jest.fn(),
    createUnmatched: jest.fn(),
    linkExistingFileInPlace: jest.fn(),
    ensureSeriesEpisode: jest.fn(),
  };
  const libraries = { requirePathFor: jest.fn().mockResolvedValue(library) };
  const metadata = { refreshSeriesEpisodes: jest.fn() };
  const events = { emit: jest.fn(), emitDomain: jest.fn() };
  const postImportQueue = { enqueue: jest.fn() };
  const nfo = {
    readForVideoFile: jest.fn().mockResolvedValue(null),
    readNfoFile: jest.fn().mockResolvedValue(null),
  };
  mockedFindLocalArtwork.mockResolvedValue({});
  const service = new DiskImportService(
    mediaRepo as never,
    fileRepo as never,
    null as never, // seasonRepo
    mediaService as never,
    null as never, // naming
    libraries as never,
    metadata as never,
    nfo as never,
    null as never, // libraryIngest
    postImportQueue as never,
    null as never, // mediaServers
    events as never,
    { upsertPending: jest.fn(), upsertRunning: jest.fn(), remove: jest.fn() } as never,
  );
  return {
    service,
    mediaRepo,
    fileRepo,
    mediaService,
    libraries,
    metadata,
    events,
    postImportQueue,
    nfo,
  };
}

const unmatchedRow = (id: number, folderName: string, type = MediaType.MOVIE) => ({
  id,
  type,
  folderName,
  files: [],
  library: { id: 1 },
  tmdbId: null,
  tvdbId: null,
  imdbId: null,
});

describe('DiskImportService.relinkOrphans: creating an unmatched title', () => {
  beforeEach(() => {
    mockedFindLocalArtwork.mockClear();
  });

  it('creates an unmatched media from the guessed title and links the files in place', async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    mediaRepo.findOne
      .mockResolvedValueOnce(null) // no existing unmatched row for this folder
      .mockResolvedValueOnce(unmatchedRow(42, 'Sample Movie (2009)')); // reload
    nfo.readForVideoFile.mockResolvedValue({ plot: 'A harbour tale.' });
    mockedFindLocalArtwork.mockResolvedValue({ poster: '/media/Sample Movie (2009)/poster.jpg' });
    mediaService.createUnmatched.mockResolvedValue({ id: 42 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(dto(), null);

    expect(nfo.readForVideoFile).toHaveBeenCalledWith(
      '/media/Sample Movie (2009)/Sample.Movie.2009.1080p.mkv',
    );
    expect(mockedFindLocalArtwork).toHaveBeenCalledWith(
      '/media/Sample Movie (2009)',
      'Sample.Movie.2009.1080p',
      { basenameOnly: false },
    );
    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sample Movie',
        year: 2009,
        type: MediaType.MOVIE,
        libraryId: 1,
        folderName: 'Sample Movie (2009)',
        nfo: { plot: 'A harbour tale.' },
        artwork: { poster: '/media/Sample Movie (2009)/poster.jpg' },
      }),
      null,
    );
    expect(res.created).toBe(true);
    expect(res.linked).toBe(1);
    expect(res.mediaId).toBe(42);
  });

  it('names a transferred folder after the .nfo year the row stores', async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    Object.assign(service, {
      naming: {
        getFormats: jest.fn().mockResolvedValue({ movieFolder: '{title} ({year})' }),
        applyMovieFolderFormat: (_f: string, d: { title: string; year?: number }) =>
          `${d.title} (${d.year})`,
      },
    });
    nfo.readForVideoFile.mockResolvedValue({ title: 'Other Placeholder', year: 1999 });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(20, 'Sample Movie Two'));
    mediaService.createUnmatched.mockResolvedValue({ id: 20 });
    jest
      .spyOn(service, 'confirmImport')
      .mockResolvedValue({ imported: 1, alreadyPresent: 0, errors: [] });

    await service.relinkOrphans(
      dto({
        transfer: 'copy',
        title: undefined,
        year: undefined,
        folderName: 'sample.movie.two.download',
        files: [{ filePath: '/downloads/Sample.Movie.Two.2010.1080p.mkv' }],
      }),
      null,
    );

    expect(mediaRepo.findOne.mock.calls[0][0].where.folderName).toBe('Sample Movie Two (1999)');
    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({
        // A real filename guess outranks the .nfo title; the .nfo still fills the year.
        title: 'Sample Movie Two',
        year: 1999,
        folderName: 'Sample Movie Two (1999)',
        nfo: expect.objectContaining({ title: undefined, year: 1999 }),
      }),
      null,
    );
  });

  it('reads a series folder for artwork with no filename basename', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    const seriesDto = dto({
      type: MediaType.SERIES,
      folderName: 'Sample Show',
      title: 'Sample Show',
      files: [
        {
          filePath: '/media/Sample Show/Season 01/Sample.Show.S01E01.mkv',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      ],
    });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(8, 'Sample Show', MediaType.SERIES));
    mediaService.createUnmatched.mockResolvedValue({ id: 8 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: 1,
      created: false,
    });

    await service.relinkOrphans(seriesDto, null);

    expect(mockedFindLocalArtwork).toHaveBeenCalledWith(
      '/media/Sample Show',
      undefined,
      { basenameOnly: false },
    );
  });

  it("reads a series' tvshow.nfo instead of the episode's own nfo", async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    const seriesDto = dto({
      type: MediaType.SERIES,
      folderName: 'Sample Show',
      title: 'Sample Show',
      files: [
        {
          filePath: '/media/Sample Show/Season 01/Sample.Show.S01E01.mkv',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      ],
    });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(9, 'Sample Show', MediaType.SERIES));
    nfo.readNfoFile.mockResolvedValue({ title: 'Sample Show Extended' });
    mediaService.createUnmatched.mockResolvedValue({ id: 9 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: 1,
      created: false,
    });

    await service.relinkOrphans(seriesDto, null);

    expect(nfo.readNfoFile).toHaveBeenCalledWith('/media/Sample Show/tvshow.nfo');
    expect(nfo.readForVideoFile).not.toHaveBeenCalled();
    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({ nfo: { title: 'Sample Show Extended' } }),
      null,
    );
  });

  it('falls back to the episode nfo when the series has no tvshow.nfo', async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    const seriesDto = dto({
      type: MediaType.SERIES,
      folderName: 'Sample Show',
      title: 'Sample Show',
      files: [
        {
          filePath: '/media/Sample Show/Season 01/Sample.Show.S01E01.mkv',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      ],
    });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(9, 'Sample Show', MediaType.SERIES));
    nfo.readNfoFile.mockResolvedValue(null);
    nfo.readForVideoFile.mockResolvedValue({ title: 'Episode-derived title' });
    mediaService.createUnmatched.mockResolvedValue({ id: 9 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: 1,
      created: false,
    });

    await service.relinkOrphans(seriesDto, null);

    expect(nfo.readForVideoFile).toHaveBeenCalledWith(
      '/media/Sample Show/Season 01/Sample.Show.S01E01.mkv',
    );
    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({ nfo: { title: 'Episode-derived title' } }),
      null,
    );
  });

  it('rejects a file outside the library root before creating anything', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.findOne.mockResolvedValueOnce(null);
    const outsideDto = dto({
      files: [{ filePath: '/etc/Sample.Movie.2009.1080p.mkv' }],
    });

    await expect(service.relinkOrphans(outsideDto, null)).rejects.toThrow(
      BadRequestException,
    );
    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
  });

  it('rejects a series folderName that escapes the library root before creating anything', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.findOne.mockResolvedValueOnce(null);
    // The sample file itself is a valid path under the root; only the
    // folderName-derived artwork dir tries to escape it.
    const escapingDto = dto({
      type: MediaType.SERIES,
      folderName: '../../etc',
      files: [
        { filePath: '/media/Sample Show/Season 01/Escape.S01E01.mkv' },
      ],
    });

    await expect(service.relinkOrphans(escapingDto, null)).rejects.toThrow(
      BadRequestException,
    );
    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
  });

  it('reuses the unmatched row already pinned to the same folder on a second scan', async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    mediaRepo.findOne.mockResolvedValueOnce(
      unmatchedRow(42, 'Sample Movie (2009)'),
    );
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 2,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(dto(), null);

    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
    expect(nfo.readForVideoFile).not.toHaveBeenCalled();
    expect(mockedFindLocalArtwork).not.toHaveBeenCalled();
    expect(res.created).toBe(false);
    expect(res.mediaId).toBe(42);
  });

  it('refuses reorganize on a title with no external id', async () => {
    const { service } = makeService();
    await expect(
      service.relinkOrphans(dto({ reorganize: true }), null),
    ).rejects.toThrow(BadRequestException);
  });

  it('looks up the folder reuse without restricting to rows that have no provider id', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(42, 'Sample Movie (2009)'));
    mediaService.createUnmatched.mockResolvedValue({ id: 42 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    await service.relinkOrphans(dto(), null);

    // An identified owner of the folder is reused, not shadowed by a second row.
    const lookupWhere = mediaRepo.findOne.mock.calls[0][0].where;
    expect(lookupWhere).not.toHaveProperty('tmdbId');
    expect(lookupWhere).not.toHaveProperty('tvdbId');
    expect(lookupWhere).not.toHaveProperty('imdbId');
  });

  it('serialises concurrent creates sharing the same library/type/folder key', async () => {
    const { service } = makeService();
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));

    const withKeyedLock = (
      service as unknown as {
        withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
      }
    ).withKeyedLock.bind(service);

    const callA = withKeyedLock('1:movie:Same Folder', async () => {
      order.push('A-start');
      await gateA;
      order.push('A-end');
      return 'a';
    });
    const callB = withKeyedLock('1:movie:Same Folder', async () => {
      order.push('B-start');
      return 'b';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['A-start']);

    releaseA();
    expect(await callA).toBe('a');
    expect(await callB).toBe('b');
    expect(order).toEqual(['A-start', 'A-end', 'B-start']);
  });

  it('skips the series episode metadata backfill for an unmatched title', async () => {
    const { service, mediaRepo, mediaService, metadata } = makeService();
    const seriesDto = dto({
      type: MediaType.SERIES,
      folderName: 'Sample Show',
      title: 'Sample Show',
      year: 2011,
      files: [
        {
          filePath: '/media/Sample Show/Sample.Show.S01E01.mkv',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      ],
    });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(7, 'Sample Show', MediaType.SERIES));
    mediaService.createUnmatched.mockResolvedValue({ id: 7 });
    // A slot is invented for the file, which would normally trigger the backfill.
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 3,
      episodeId: 99,
      created: true,
    });

    const res = await service.relinkOrphans(seriesDto, null);

    expect(res.linked).toBe(1);
    expect(metadata.refreshSeriesEpisodes).not.toHaveBeenCalled();
  });

  it('leaves the identified path untouched when an externalId is given', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    const identifiedDto = dto({ externalId: '999', provider: 'tmdb' });
    mediaRepo.findOne
      .mockResolvedValueOnce(null) // no media with this tmdbId yet
      .mockResolvedValueOnce({
        id: 55,
        type: MediaType.MOVIE,
        folderName: identifiedDto.folderName,
        files: [],
        library: { id: 1 },
        tmdbId: 999,
        tvdbId: null,
        imdbId: null,
      });
    mediaService.importMedia.mockResolvedValue({ id: 55 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(identifiedDto, null);

    expect(mediaService.importMedia).toHaveBeenCalled();
    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
    expect(res.created).toBe(true);
    expect(res.mediaId).toBe(55);
  });

  it('refuses reorganize for an identified movie with no folder of its own', async () => {
    const { service } = makeService();
    const rootDto = dto({
      externalId: '999',
      provider: 'tmdb',
      reorganize: true,
      folderName: '',
      files: [{ filePath: '/media/sample.movie.2001.1080p.mkv' }],
    });
    await expect(service.relinkOrphans(rootDto, null)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('DiskImportService.relinkOrphans: movie files directly at the library root', () => {
  const rootDto = (overrides: Partial<RelinkOrphansDto> = {}): RelinkOrphansDto =>
    dto({
      folderName: '',
      title: 'Sample Movie',
      files: [{ filePath: '/media/sample.movie.2001.1080p.mkv' }],
      ...overrides,
    });

  it('creates the media with an empty folderName and links the file in place', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.find.mockResolvedValueOnce([]); // no unmatched root row yet
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(1, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 1 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(rootDto(), null);

    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({ folderName: '' }),
      null,
    );
    expect(res.created).toBe(true);
    expect(res.mediaId).toBe(1);
  });

  it('does not merge two different root-level movies sharing folderName \'\'', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    const movieA = {
      ...unmatchedRow(1, ''),
      files: [{ relativePath: 'sample.movie.2001.mkv' }],
    };
    // The only existing unmatched root row is a different file: reuse must
    // not pick it just because folderName also happens to be ''.
    mediaRepo.find.mockResolvedValueOnce([movieA]);
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(2, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 2 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 2,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(
      rootDto({ files: [{ filePath: '/media/sample.movie.2.2002.mkv' }] }),
      null,
    );

    expect(mediaService.createUnmatched).toHaveBeenCalled();
    expect(res.mediaId).toBe(2);
  });

  it('reuses the same root row when its own file is scanned again', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    const movieA = {
      ...unmatchedRow(1, ''),
      files: [{ relativePath: 'sample.movie.2001.mkv' }],
    };
    mediaRepo.find.mockResolvedValueOnce([movieA]);
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(
      rootDto({ files: [{ filePath: '/media/sample.movie.2001.mkv' }] }),
      null,
    );

    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
    expect(res.mediaId).toBe(1);
  });

  it('only matches basename-prefixed artwork and reads the per-file nfo, not the shared root', async () => {
    const { service, mediaRepo, mediaService, nfo } = makeService();
    mediaRepo.find.mockResolvedValueOnce([]);
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(3, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 3 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    await service.relinkOrphans(rootDto(), null);

    expect(nfo.readNfoFile).toHaveBeenCalledWith('/media/sample.movie.2001.1080p.nfo');
    expect(nfo.readForVideoFile).not.toHaveBeenCalled();
    expect(mockedFindLocalArtwork).toHaveBeenCalledWith(
      '/media',
      'sample.movie.2001.1080p',
      { basenameOnly: true },
    );
  });

  it('derives the title from the filename when the client sent none', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.find.mockResolvedValueOnce([]);
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(4, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 4 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    await service.relinkOrphans(
      rootDto({
        title: '',
        files: [{ filePath: '/media/Sample.Movie.Two.2002.1080p.mkv' }],
      }),
      null,
    );

    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sample Movie Two' }),
      null,
    );
  });

  it('deletes the freshly created row when its only file fails to link', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.find.mockResolvedValueOnce([]);
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(5, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 5 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      error: 'file outside the media folder',
    });

    const res = await service.relinkOrphans(rootDto(), null);

    expect(res.linked).toBe(0);
    expect(mediaRepo.delete).toHaveBeenCalledWith(5);
  });

  it('keeps the row when a concurrent group already linked a file to it', async () => {
    const { service, mediaRepo, mediaService, fileRepo } = makeService();
    mediaRepo.find.mockResolvedValueOnce([]);
    mediaRepo.findOne.mockResolvedValueOnce(unmatchedRow(6, ''));
    mediaService.createUnmatched.mockResolvedValue({ id: 6 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      error: 'file outside the media folder',
    });
    // A concurrent relink reused this row and linked its own file first.
    fileRepo.count.mockResolvedValueOnce(1);

    const res = await service.relinkOrphans(rootDto(), null);

    expect(res.linked).toBe(0);
    expect(fileRepo.count).toHaveBeenCalledWith({ where: { media: { id: 6 } } });
    expect(mediaRepo.delete).not.toHaveBeenCalled();
  });
});

describe('DiskImportService.relinkOrphans: files outside the library', () => {
  it('names the new unmatched title by the library layout and copies its files in', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    Object.assign(service, {
      naming: {
        getFormats: jest.fn().mockResolvedValue({ seriesFolder: '{Series Title}' }),
        applySeriesFolderFormat: (_f: string, d: { seriesTitle: string }) => d.seriesTitle,
      },
    });
    const confirmImport = jest
      .spyOn(service, 'confirmImport')
      .mockResolvedValue({ imported: 1, alreadyPresent: 0, errors: [] });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(9, 'Sample Show', MediaType.SERIES));
    mediaService.createUnmatched.mockResolvedValue({ id: 9 });
    mediaService.ensureSeriesEpisode.mockResolvedValue({ episodeId: 3, created: false });

    const res = await service.relinkOrphans(
      dto({
        type: MediaType.SERIES,
        folderName: 'sample.show.complete',
        title: 'Sample Show',
        year: undefined,
        transfer: 'copy',
        files: [
          {
            filePath: '/downloads/sample.show.complete/S01/Sample.Show.S01E01.mkv',
            seasonNumber: 1,
            episodeNumber: 1,
          },
        ],
      }),
      null,
    );

    expect(mockedFindLocalArtwork).toHaveBeenCalledWith(
      '/downloads/sample.show.complete',
      undefined,
      { basenameOnly: false },
    );
    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({ folderName: 'Sample Show', libraryId: 1 }),
      null,
    );
    expect(confirmImport).toHaveBeenCalledWith(
      [expect.objectContaining({ mediaId: 9, episodeId: 3, targetLibraryId: 1 })],
      'copy',
      { uniquifyOnCollision: false },
    );
    expect(res.linked).toBe(1);
  });

  it('picks the outermost ancestor when a season folder repeats the show name', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    Object.assign(service, {
      naming: {
        getFormats: jest.fn().mockResolvedValue({ seriesFolder: '{Series Title}' }),
        applySeriesFolderFormat: (_f: string, d: { seriesTitle: string }) => d.seriesTitle,
      },
    });
    jest
      .spyOn(service, 'confirmImport')
      .mockResolvedValue({ imported: 1, alreadyPresent: 0, errors: [] });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(11, 'Sample Show', MediaType.SERIES));
    mediaService.createUnmatched.mockResolvedValue({ id: 11 });
    mediaService.ensureSeriesEpisode.mockResolvedValue({ episodeId: 4, created: false });

    await service.relinkOrphans(
      dto({
        type: MediaType.SERIES,
        folderName: 'Sample Show',
        title: 'Sample Show',
        year: undefined,
        transfer: 'copy',
        files: [
          {
            filePath: '/downloads/Sample Show/Sample Show/S01/Sample.Show.S01E01.mkv',
            seasonNumber: 1,
            episodeNumber: 1,
          },
        ],
      }),
      null,
    );

    // The outer `/downloads/Sample Show`, not the inner directory the season sits in.
    expect(mockedFindLocalArtwork).toHaveBeenCalledWith(
      '/downloads/Sample Show',
      undefined,
      { basenameOnly: false },
    );
  });
});
