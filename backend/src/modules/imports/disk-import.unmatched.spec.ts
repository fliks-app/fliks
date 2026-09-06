import { BadRequestException } from '@nestjs/common';
import { DiskImportService } from './disk-import.service';
import { RelinkOrphansDto } from './dto/relink-orphans.dto';
import { MediaType } from '../../common/enums';

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
    folderName: 'Quiet Harbour (2009)',
    title: 'Quiet Harbour',
    year: 2009,
    files: [{ filePath: '/media/Quiet Harbour (2009)/Quiet.Harbour.2009.1080p.mkv' }],
    ...overrides,
  }) as RelinkOrphansDto;

function makeService() {
  const mediaRepo = { findOne: jest.fn(), update: jest.fn() };
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
  const service = new DiskImportService(
    mediaRepo as never,
    null as never, // fileRepo
    null as never, // seasonRepo
    null as never, // episodeRepo
    mediaService as never,
    null as never, // naming
    libraries as never,
    metadata as never,
    null as never, // nfo
    null as never, // libraryIngest
    postImportQueue as never,
    null as never, // mediaServers
    events as never,
    { upsertPending: jest.fn(), upsertRunning: jest.fn(), remove: jest.fn() } as never,
  );
  return { service, mediaRepo, mediaService, libraries, metadata, events, postImportQueue };
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
  it('creates an unmatched media from the guessed title and links the files in place', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.findOne
      .mockResolvedValueOnce(null) // no existing unmatched row for this folder
      .mockResolvedValueOnce(unmatchedRow(42, 'Quiet Harbour (2009)')); // reload
    mediaService.createUnmatched.mockResolvedValue({ id: 42 });
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 1,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(dto(), null);

    expect(mediaService.createUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Quiet Harbour',
        year: 2009,
        type: MediaType.MOVIE,
        libraryId: 1,
        folderName: 'Quiet Harbour (2009)',
      }),
      null,
    );
    expect(res.created).toBe(true);
    expect(res.linked).toBe(1);
    expect(res.mediaId).toBe(42);
  });

  it('reuses the unmatched row already pinned to the same folder on a second scan', async () => {
    const { service, mediaRepo, mediaService } = makeService();
    mediaRepo.findOne.mockResolvedValueOnce(
      unmatchedRow(42, 'Quiet Harbour (2009)'),
    );
    mediaService.linkExistingFileInPlace.mockResolvedValue({
      fileId: 2,
      episodeId: null,
      created: false,
    });

    const res = await service.relinkOrphans(dto(), null);

    expect(mediaService.createUnmatched).not.toHaveBeenCalled();
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
      folderName: 'Northern Lights',
      title: 'Northern Lights',
      year: 2011,
      files: [
        {
          filePath: '/media/Northern Lights/Northern.Lights.S01E01.mkv',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      ],
    });
    mediaRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(unmatchedRow(7, 'Northern Lights', MediaType.SERIES));
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
});
