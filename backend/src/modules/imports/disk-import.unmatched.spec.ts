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
    null as never, // fileRepo
    null as never, // seasonRepo
    null as never, // episodeRepo
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
  return { service, mediaRepo, mediaService, libraries, metadata, events, postImportQueue, nfo };
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
});
