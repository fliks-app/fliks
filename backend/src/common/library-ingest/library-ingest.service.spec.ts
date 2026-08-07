import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { LibraryIngestService, IngestRequest } from './library-ingest.service';
import { NamingService } from '../../modules/scheduler/naming.service';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { MediaType } from '../enums';

/**
 * `ingest` is the only public method and only touches the collaborators wired
 * below, so we exercise it on a bare prototype instance rather than standing
 * up the 8-dependency constructor — same approach as CompletionService specs.
 */
function buildHarness() {
  const service = Object.create(
    LibraryIngestService.prototype,
  ) as LibraryIngestService;

  const mediaRepo = { findOne: jest.fn() };
  const fileRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
  };
  const episodeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const fileTransfer = {
    transferFile: jest.fn().mockResolvedValue(undefined),
    transferCompanions: jest.fn().mockResolvedValue(undefined),
    getCompanionExts: jest.fn().mockResolvedValue(new Set<string>()),
  };
  const mediaService = {
    finalizeImportedFile: jest.fn().mockResolvedValue(undefined),
  };
  const subtitleScheduler = {
    onMediaFileImported: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // Real NamingService — a stubbed `query` returning no rows means
  // `getFormats()` resolves the built-in defaults, no DB needed.
  const naming = new NamingService({
    query: jest.fn().mockResolvedValue([]),
  } as unknown as DataSource);
  // Null probe result: both tests fall back to `fallbackQuality` and no
  // `streamInfo` is written.
  const ffprobe = { detectMediaFileInfo: jest.fn().mockResolvedValue(null) };

  const wired = service as unknown as Record<string, unknown>;
  wired.mediaRepo = mediaRepo;
  wired.fileRepo = fileRepo;
  wired.episodeRepo = episodeRepo;
  wired.naming = naming;
  wired.fileTransfer = fileTransfer;
  wired.mediaService = mediaService;
  wired.subtitleScheduler = subtitleScheduler;
  wired.ffprobe = ffprobe;
  wired.logger = logger;

  return {
    service,
    mediaRepo,
    fileRepo,
    episodeRepo,
    fileTransfer,
    mediaService,
    subtitleScheduler,
    ffprobe,
    logger,
  };
}

function buildMovie(over: Partial<Media> & { path: string }): Media {
  return {
    id: 1,
    title: 'Lonely Harbor',
    originalTitle: undefined,
    year: 2021,
    type: MediaType.MOVIE,
    tmdbId: undefined,
    library: { id: 10 },
    folderName: 'Lonely Harbor (2021)',
    ...over,
  } as unknown as Media;
}

describe('LibraryIngestService.ingest', () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-ingest-src-'));
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it('updates the existing row in place on a forced re-import instead of inserting a second one', async () => {
    const h = buildHarness();
    const srcFile = path.join(srcDir, 'Lonely.Harbor.2021.mkv');
    fs.writeFileSync(srcFile, 'x'.repeat(4096));

    const media = buildMovie({ id: 7, path: '/library/movies/Lonely Harbor (2021)' });
    h.mediaRepo.findOne.mockResolvedValue(media);

    const existingRow = {
      id: 501,
      media: { id: 7 },
      relativePath: 'Lonely Harbor (2021) WEBDL-1080p.mkv',
      size: 999,
      quality: 'HDTV-720p',
      episode: null,
    } as unknown as MediaFile;
    h.fileRepo.findOne.mockResolvedValue(existingRow);

    const req: IngestRequest = {
      mediaId: 7,
      files: [{ path: srcFile }],
      transfer: 'copy',
      fallbackQuality: 'WEBDL-1080p',
      sourceLabel: 'Lonely Harbor',
      force: true,
    };

    const result = await h.service.ingest(req);

    expect(h.fileRepo.create).not.toHaveBeenCalled();
    expect(h.fileRepo.save).toHaveBeenCalledTimes(1);
    expect(h.fileRepo.save).toHaveBeenCalledWith(existingRow);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].file).toEqual({
      id: 501,
      media: { id: 7 },
      relativePath: 'Lonely Harbor (2021) WEBDL-1080p.mkv',
      size: 4096,
      quality: 'WEBDL-1080p',
      episode: null,
    });
  });

  it('reports success and still returns the imported file when enrichment throws', async () => {
    const h = buildHarness();
    const srcFile = path.join(srcDir, 'Coral.Drift.2022.mkv');
    fs.writeFileSync(srcFile, 'y'.repeat(2048));

    const media = buildMovie({
      id: 8,
      title: 'Coral Drift',
      year: 2022,
      path: '/library/movies/Coral Drift (2022)',
    });
    h.mediaRepo.findOne.mockResolvedValue(media);
    h.fileRepo.findOne.mockResolvedValue(null);
    h.mediaService.finalizeImportedFile.mockRejectedValue(
      new Error('ffprobe crashed'),
    );

    const req: IngestRequest = {
      mediaId: 8,
      files: [{ path: srcFile }],
      transfer: 'copy',
      fallbackQuality: 'WEBDL-720p',
      sourceLabel: 'Coral Drift',
    };

    const result = await h.service.ingest(req);
    // Post-import work is fire-and-forget — let it settle before asserting.
    await new Promise((r) => setImmediate(r));

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].file).toEqual({
      media,
      episode: null,
      relativePath: 'Coral Drift (2022) WEBDL-720p.mkv',
      size: 2048,
      quality: 'WEBDL-720p',
    });
    expect(h.mediaService.finalizeImportedFile).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      'Ingest[Coral Drift]: post-import enrichment failed — ffprobe crashed',
    );
  });
});
