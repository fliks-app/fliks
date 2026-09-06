import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaRescanService } from './media-rescan.service';
import { MediaType } from '../../../common/enums';

/**
 * Wires every collaborator `enrichMediaFileFromDisk` / `rescanFiles` touch
 * onto a bare prototype instance — same approach as the other media-service
 * specs, avoiding the 12-dependency constructor.
 */
function buildHarness() {
  const service = Object.create(MediaRescanService.prototype) as MediaRescanService;

  const mediaFileRepo = {
    findOne: jest.fn(),
    save: jest.fn(async (x: unknown) => x),
    find: jest.fn().mockResolvedValue([]),
    remove: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((x: unknown) => x),
  };
  const mediaRepo = { findOne: jest.fn() };
  const episodeRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const seasonRepo = {};
  const naming = { parseEpisodeNumbers: jest.fn() };
  const ffprobe = {
    detectMediaFileInfo: jest.fn(),
    detectCrop: jest.fn().mockResolvedValue(null),
  };
  const subtitles = {
    reconcileSubtitleFilesAfterRescan: jest
      .fn()
      .mockResolvedValue({ removedMissing: 0, removedDuplicates: 0 }),
    discoverExternalSubtitles: jest.fn().mockResolvedValue(0),
  };
  const embeddedSubtitle = { detectAndStore: jest.fn().mockResolvedValue(undefined) };
  const subtitleStream = {
    clearMediaFileSubtitleCache: jest.fn().mockResolvedValue(undefined),
    warmupCache: jest.fn().mockResolvedValue(undefined),
  };
  const thumbnailService = {};
  const mediaServers = { dispatch: jest.fn() };
  const metadata = { refreshSeriesEpisodes: jest.fn().mockResolvedValue(undefined) };
  const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const postImportQueue = { enqueue: jest.fn() };

  const wired = service as unknown as Record<string, unknown>;
  wired.mediaRepo = mediaRepo;
  wired.seasonRepo = seasonRepo;
  wired.episodeRepo = episodeRepo;
  wired.mediaFileRepo = mediaFileRepo;
  wired.naming = naming;
  wired.ffprobe = ffprobe;
  wired.subtitles = subtitles;
  wired.embeddedSubtitle = embeddedSubtitle;
  wired.subtitleStream = subtitleStream;
  wired.thumbnailService = thumbnailService;
  wired.mediaServers = mediaServers;
  wired.metadata = metadata;
  wired.log = log;
  wired.postImportQueue = postImportQueue;

  return {
    service,
    mediaRepo,
    mediaFileRepo,
    episodeRepo,
    ffprobe,
    subtitles,
    embeddedSubtitle,
    subtitleStream,
    mediaServers,
    metadata,
    log,
    postImportQueue,
  };
}

describe('MediaRescanService.enrichMediaFileFromDisk — quality from probe results', () => {
  let mediaDir: string;

  beforeEach(() => {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-enrich-'));
  });

  afterEach(() => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  function dbFileIn(mediaDirPath: string, filename: string, quality: string) {
    const absPath = path.join(mediaDirPath, filename);
    fs.writeFileSync(absPath, 'video-bytes');
    return {
      id: 5,
      relativePath: filename,
      size: 1,
      quality,
      streamInfo: null,
      media: { path: mediaDirPath, title: 'Ember Horizon' },
    };
  }

  it('derives quality from real dimensions and overwrites the stale value', async () => {
    const h = buildHarness();
    const dbFile = dbFileIn(mediaDir, 'Ember.Horizon.2022.1080p.WEB-DL-RELGRP.mkv', 'HDTV-720p');
    h.mediaFileRepo.findOne.mockResolvedValue(dbFile);
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({
      video: [{ width: 1920, height: 1080 }],
      audio: [],
      subtitles: [],
    });

    await h.service.enrichMediaFileFromDisk(5);

    expect(dbFile.quality).toBe('WEBDL-1080p');
  });

  it('keeps the existing quality when the probe reports no video stream', async () => {
    const h = buildHarness();
    const dbFile = dbFileIn(mediaDir, 'Ember.Horizon.2022.1080p.WEB-DL-RELGRP.mkv', 'WEBDL-1080p');
    h.mediaFileRepo.findOne.mockResolvedValue(dbFile);
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({ video: [], audio: [], subtitles: [] });

    await h.service.enrichMediaFileFromDisk(5);

    expect(dbFile.quality).toBe('WEBDL-1080p');
  });

  it('keeps the existing quality and skips saving when ffprobe throws', async () => {
    const h = buildHarness();
    const dbFile = dbFileIn(mediaDir, 'Ember.Horizon.2022.1080p.WEB-DL-RELGRP.mkv', 'WEBDL-1080p');
    h.mediaFileRepo.findOne.mockResolvedValue(dbFile);
    h.ffprobe.detectMediaFileInfo.mockRejectedValue(new Error('ffprobe crashed'));

    await h.service.enrichMediaFileFromDisk(5);

    expect(dbFile.quality).toBe('WEBDL-1080p');
    expect(h.mediaFileRepo.save).not.toHaveBeenCalled();
  });
});

describe('MediaRescanService.rescanFiles — quality from probe results', () => {
  let mediaDir: string;

  beforeEach(() => {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-files-'));
  });

  afterEach(() => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  function movieMedia(over: Record<string, unknown>) {
    return {
      id: 8,
      title: 'Ember Horizon',
      type: MediaType.MOVIE,
      folderName: 'Sample Movie (2001)',
      files: [],
      get path() {
        return mediaDir;
      },
      ...over,
    };
  }

  it('keeps an existing file quality unchanged when the refresh probe finds no video stream', async () => {
    const h = buildHarness();
    const filename = 'Ember.Horizon.2022.1080p.WEB-DL-RELGRP.mkv';
    fs.writeFileSync(path.join(mediaDir, filename), 'video-bytes');
    const dbFile = {
      id: 9,
      relativePath: filename,
      size: 999,
      quality: 'WEBDL-1080p',
      streamInfo: null,
    };
    h.mediaRepo.findOne.mockResolvedValue(movieMedia({ files: [dbFile] }));
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({ video: [], audio: [], subtitles: [] });

    await h.service.rescanFiles(8, { skipWarmup: true });

    expect(dbFile.quality).toBe('WEBDL-1080p');
  });

  it('assigns the filename-derived 480p fallback to a brand-new file when the probe finds no video stream', async () => {
    const h = buildHarness();
    const filename = 'Ember.Horizon.2022.1080p.WEB-DL-RELGRP.mkv';
    fs.writeFileSync(path.join(mediaDir, filename), 'video-bytes');
    h.mediaRepo.findOne.mockResolvedValue(movieMedia({ files: [] }));
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({ video: [], audio: [], subtitles: [] });

    await h.service.rescanFiles(8, { skipWarmup: true });

    expect(h.mediaFileRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: filename, quality: 'WEBDL-480p' }),
    );
  });
});

describe('MediaRescanService.rescanFiles - a movie with no folder of its own', () => {
  let mediaDir: string;

  beforeEach(() => {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-root-movie-'));
  });

  afterEach(() => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  function rootMovieMedia(over: Record<string, unknown>) {
    return {
      id: 11,
      title: 'Sample Movie',
      type: MediaType.MOVIE,
      folderName: '',
      files: [],
      get path() {
        return mediaDir;
      },
      ...over,
    };
  }

  it('never walks the shared library root: a sibling root-level movie file is not discovered', async () => {
    const h = buildHarness();
    const ownFilename = 'sample.movie.2001.1080p.mkv';
    fs.writeFileSync(path.join(mediaDir, ownFilename), 'video-bytes');
    // Another root-level movie's own file, sitting right next to this one.
    fs.writeFileSync(path.join(mediaDir, 'sample.movie.2.2002.1080p.mkv'), 'video-bytes');
    const dbFile = {
      id: 21,
      relativePath: ownFilename,
      size: 1,
      quality: 'WEBDL-1080p',
      streamInfo: null,
    };
    h.mediaRepo.findOne.mockResolvedValue(rootMovieMedia({ files: [dbFile] }));
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({
      video: [{ width: 1920, height: 1080 }],
      audio: [],
      subtitles: [],
    });

    const res = await h.service.rescanFiles(11, { skipWarmup: true });

    expect(res.added).toBe(0);
    expect(h.mediaFileRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'sample.movie.2.2002.1080p.mkv' }),
    );
    // Its own file is still refreshed.
    expect(res.updated).toBe(1);
  });

  it('does not wipe the shared .cache directory at the library root', async () => {
    const h = buildHarness();
    const cacheDir = path.join(mediaDir, '.cache');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, 'marker.txt'), 'x');
    h.mediaRepo.findOne.mockResolvedValue(rootMovieMedia({ files: [] }));
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({ video: [], audio: [], subtitles: [] });

    await h.service.rescanFiles(11, { skipWarmup: true });

    expect(fs.existsSync(cacheDir)).toBe(true);
  });
});

describe('MediaRescanService.linkExistingFileInPlace - a movie with no folder of its own', () => {
  it('refuses a file nested in a subfolder of the shared library root', async () => {
    const h = buildHarness();
    const media = {
      id: 11,
      type: MediaType.MOVIE,
      folderName: '',
      path: '/library/movies',
    } as never;

    const res = await h.service.linkExistingFileInPlace({
      media,
      absPath: '/library/movies/Some Folder/sample.movie.2001.mkv',
    });

    expect(res).toEqual({
      error: 'a title with no folder can only own files at the library root',
    });
    expect(h.mediaFileRepo.findOne).not.toHaveBeenCalled();
  });
});
