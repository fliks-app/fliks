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
  const playbackUpdates: Record<string, unknown>[] = [];
  const playbackRepo = {
    createQueryBuilder: () => {
      const qb = {
        update: () => qb,
        set: (v: unknown) => (playbackUpdates.push({ set: v }), qb),
        where: (_: string, p: Record<string, unknown>) => (
          Object.assign(playbackUpdates[playbackUpdates.length - 1], p), qb
        ),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      return qb;
    },
  };
  const mediaService = { deleteMediaFile: jest.fn().mockResolvedValue(undefined) };
  const subtitles = { carryOver: jest.fn().mockResolvedValue([]) };
  const subtitleSync = { syncSubtitle: jest.fn().mockResolvedValue(undefined) };
  const fileRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
    find: jest.fn().mockResolvedValue([]),
    manager: { getRepository: () => playbackRepo },
  };
  const episodeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const seasonRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const fileTransfer = {
    transferFile: jest.fn().mockResolvedValue(undefined),
    transferCompanions: jest.fn().mockResolvedValue(undefined),
    getCompanionExts: jest.fn().mockResolvedValue(new Set<string>()),
  };
  const postImportQueue = { enqueue: jest.fn() };
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
  wired.seasonRepo = seasonRepo;
  wired.naming = naming;
  wired.fileTransfer = fileTransfer;
  wired.postImportQueue = postImportQueue;
  wired.ffprobe = ffprobe;
  wired.logger = logger;
  wired.events = { emitDomain: jest.fn() };
  wired.mediaService = mediaService;
  wired.subtitles = subtitles;
  wired.subtitleSync = subtitleSync;

  return {
    service,
    mediaRepo,
    fileRepo,
    episodeRepo,
    seasonRepo,
    fileTransfer,
    postImportQueue,
    ffprobe,
    logger,
    mediaService,
    playbackUpdates,
    subtitles,
    subtitleSync,
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

function buildSeries(over: Partial<Media> & { path: string }): Media {
  return {
    id: 20,
    title: 'Nova Skyline',
    originalTitle: undefined,
    year: 2025,
    type: MediaType.SERIES,
    tmdbId: undefined,
    library: { id: 10 },
    folderName: 'Nova Skyline',
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

    const media = buildMovie({
      id: 7,
      path: '/library/movies/Lonely Harbor (2021)',
    });
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

  it('enqueues post-import enrichment for each imported file', async () => {
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
    h.fileRepo.save.mockImplementation(async (x: unknown) => ({
      ...(x as object),
      id: 42,
    }));

    const req: IngestRequest = {
      mediaId: 8,
      files: [{ path: srcFile }],
      transfer: 'copy',
      fallbackQuality: 'WEBDL-720p',
      sourceLabel: 'Coral Drift',
    };

    const result = await h.service.ingest(req);

    expect(result.imported).toHaveLength(1);
    expect(h.postImportQueue.enqueue).toHaveBeenCalledWith({ mediaFileId: 42 });
  });

  /**
   * A special's number is nowhere in its filename — only its title is. Without the title
   * match the file imports as season 1 episode 1 (or not at all).
   */
  it('VERDICT: places a special with no numbering into season 0 by its title', async () => {
    const h = buildHarness();
    const srcFile = path.join(
      srcDir,
      'Nova.Skyline.Behind.The.Scenes.1080p.WEB-DL.mkv',
    );
    fs.writeFileSync(srcFile, 'z'.repeat(2048));

    h.mediaRepo.findOne.mockResolvedValue(
      buildSeries({ id: 20, path: '/library/tv/Nova Skyline' }),
    );
    h.seasonRepo.findOne.mockResolvedValue({
      id: 900,
      seasonNumber: 0,
      episodes: [
        { id: 9001, episodeNumber: 1, title: 'Teaser', airDate: null },
        {
          id: 9002,
          episodeNumber: 2,
          title: 'Behind the Scenes',
          airDate: null,
        },
      ],
    });

    const result = await h.service.ingest({
      mediaId: 20,
      files: [{ path: srcFile }],
      transfer: 'copy',
      fallbackQuality: 'WEBDL-1080p',
      sourceLabel: 'Nova Skyline',
    });

    expect(h.seasonRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { media: { id: 20 }, seasonNumber: 0 },
      }),
    );
    expect(result.imported[0].file.relativePath).toContain('Season 00');
    expect(result.imported[0].file.relativePath).toContain('S00E02');
    expect(h.episodeRepo.update).toHaveBeenCalledWith(9002, { hasFile: true });
  });

  it('ignores a caller episode that belongs to another media', async () => {
    const h = buildHarness();
    const srcFile = path.join(srcDir, 'Other.Show.S01E03.1080p.mkv');
    fs.writeFileSync(srcFile, 'z'.repeat(2048));

    h.mediaRepo.findOne.mockResolvedValue(
      buildSeries({ id: 20, path: '/library/tv/Nova Skyline' }),
    );
    h.seasonRepo.findOne.mockResolvedValue({ id: 700, seasonNumber: 1 });
    h.episodeRepo.findOne.mockImplementation(async ({ where }) =>
      where.id === 555 ? null : { id: 7003, episodeNumber: 3, title: null },
    );

    const result = await h.service.ingest({
      mediaId: 20,
      files: [{ path: srcFile, episodeId: 555 }],
      transfer: 'copy',
      fallbackQuality: 'WEBDL-1080p',
      sourceLabel: 'Nova Skyline',
    });

    expect(h.episodeRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 555, season: { media: { id: 20 } } },
      }),
    );
    expect(result.imported[0].file.episode).toEqual({ id: 7003 });
    expect(h.episodeRepo.update).toHaveBeenCalledWith(7003, { hasFile: true });
    expect(h.episodeRepo.update).not.toHaveBeenCalledWith(555, expect.anything());
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('episode #555'));
  });

  it('refuses to place a grabbed file at the library root when the media has no folder of its own', async () => {
    const h = buildHarness();
    const srcFile = path.join(srcDir, 'sample.movie.2001.1080p.mkv');
    fs.writeFileSync(srcFile, 'x');

    const media = buildMovie({ id: 9, folderName: '', path: '/library/movies' });
    h.mediaRepo.findOne.mockResolvedValue(media);

    await expect(
      h.service.ingest({
        mediaId: 9,
        files: [{ path: srcFile }],
        transfer: 'copy',
        fallbackQuality: 'WEBDL-1080p',
        sourceLabel: 'Sample Movie',
      }),
    ).rejects.toThrow('has no folder of its own');
  });

  describe('replaceExisting', () => {
    let libDir: string;
    beforeEach(() => {
      libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-ingest-lib-'));
    });
    afterEach(() => fs.rmSync(libDir, { recursive: true, force: true }));

    const seriesHarness = (h: ReturnType<typeof buildHarness>) => {
      h.seasonRepo.findOne.mockResolvedValue({ id: 300, seasonNumber: 1 });
      h.episodeRepo.findOne.mockImplementation(
        async ({ where }: { where: { episodeNumber: number } }) => ({
          id: 400 + where.episodeNumber,
          episodeNumber: where.episodeNumber,
        }),
      );
      let nextId = 900;
      h.fileRepo.save.mockImplementation(async (x: Record<string, unknown>) => ({
        id: nextId++,
        ...x,
      }));
    };
    const oldEpisodeFile = (id: number, ep: number, end: number | null = null) =>
      ({
        id,
        relativePath: `Season 01/old-E${ep}.mkv`,
        episode: { id: 400 + ep, episodeNumber: ep, endEpisodeNumber: end, season: { seasonNumber: 1 } },
      }) as unknown as MediaFile;

    it('deletes the previous movie file and moves playback onto the new one', async () => {
      const h = buildHarness();
      const src = path.join(srcDir, 'Lonely.Harbor.2021.2160p.mkv');
      fs.writeFileSync(src, 'x');
      h.mediaRepo.findOne.mockResolvedValue(buildMovie({ id: 7, path: libDir }));
      h.fileRepo.save.mockImplementation(async (x: Record<string, unknown>) => ({ id: 900, ...x }));
      h.fileRepo.find.mockResolvedValue([{ id: 501, relativePath: 'old.mkv', episode: null }]);

      await h.service.ingest({
        mediaId: 7, files: [{ path: src }], transfer: 'copy',
        fallbackQuality: 'WEBDL-2160p', sourceLabel: 'x', replaceExisting: true,
      });

      expect(h.playbackUpdates).toEqual([{ set: { mediaFile: { id: 900 } }, old: 501 }]);
      expect(h.mediaService.deleteMediaFile).toHaveBeenCalledWith(7, 501, true);
      expect(h.subtitles.carryOver).toHaveBeenCalledWith(7, 501, expect.objectContaining({ id: 900 }));
    });

    it('drops the replaced file EDL (any case) and still transfers the source EDL', async () => {
      const h = buildHarness();
      const src = path.join(srcDir, 'Lonely.Harbor.2021.2160p.mkv');
      fs.writeFileSync(src, 'x');
      fs.writeFileSync(path.join(srcDir, 'Lonely.Harbor.2021.2160p.edl'), '3 4 0\n');
      h.mediaRepo.findOne.mockResolvedValue(buildMovie({ id: 7, path: libDir }));
      h.fileRepo.save.mockImplementation(async (x: Record<string, unknown>) => ({ id: 900, ...x }));
      h.fileRepo.find.mockResolvedValue([{ id: 501, relativePath: 'old.mp4', episode: null }]);
      h.fileTransfer.transferFile.mockImplementation(async (from: string, to: string) =>
        fs.copyFileSync(from, to));
      h.fileTransfer.transferCompanions.mockImplementation(
        async (o: { srcDir: string; destDir: string; sourceBaseName: string; newBaseName: string }) =>
          fs.copyFileSync(
            path.join(o.srcDir, `${o.sourceBaseName}.edl`),
            path.join(o.destDir, `${o.newBaseName}.edl`),
          ),
      );
      const all = () => (fs.readdirSync(libDir, { recursive: true }) as string[]).map((n) => path.join(libDir, n));
      const run = () =>
        h.service.ingest({
          mediaId: 7, files: [{ path: src }], transfer: 'copy',
          fallbackQuality: 'WEBDL-2160p', sourceLabel: 'x', replaceExisting: true,
        });
      await run();
      const mkv = all().find((n) => n.endsWith('.mkv'))!;
      const edl = mkv.replace(/\.mkv$/, '.EDL');
      for (const f of all().filter((n) => /\.edl$/i.test(n))) fs.rmSync(f);
      fs.writeFileSync(edl, 'stale');
      fs.rmSync(mkv);
      await run();
      const left = all().filter((n) => /\.edl$/i.test(n));
      expect(left).toHaveLength(1);
      expect(fs.readFileSync(left[0], 'utf8')).toBe('3 4 0\n');
    });

    it('replaces the single-episode files a season pack covers, keeps a partly covered range', async () => {
      const h = buildHarness();
      seriesHarness(h);
      const files = [1, 2, 3].map((e) => {
        const p = path.join(srcDir, `Nova.Skyline.S01E0${e}.1080p.mkv`);
        fs.writeFileSync(p, 'x');
        return { path: p };
      });
      h.mediaRepo.findOne.mockResolvedValue(buildSeries({ id: 20, path: libDir }));
      h.fileRepo.find.mockResolvedValue([
        oldEpisodeFile(601, 1),
        oldEpisodeFile(602, 2),
        oldEpisodeFile(603, 3, 4), // E03-E04: E04 not in the pack
      ]);

      await h.service.ingest({
        mediaId: 20, files, transfer: 'copy',
        fallbackQuality: 'WEBDL-1080p', sourceLabel: 'x', replaceExisting: true,
      });

      expect(h.mediaService.deleteMediaFile.mock.calls.map((c) => c[1])).toEqual([601, 602]);
      expect(h.subtitles.carryOver.mock.calls.map((c) => [c[1], c[2].id])).toEqual([[601, 900], [602, 901]]);
      expect(h.playbackUpdates).toContainEqual({ set: { mediaFile: { id: 900 } }, old: 601, ep: 401 });
    });

    it('overwrites a same-named file of a different size instead of skipping it', async () => {
      const h = buildHarness();
      const src = path.join(srcDir, 'Lonely.Harbor.2021.mkv');
      fs.writeFileSync(src, 'new-bytes');
      const media = buildMovie({ id: 7, path: libDir });
      h.mediaRepo.findOne.mockResolvedValue(media);
      const dest = path.join(libDir, 'Lonely Harbor (2021) WEBDL-1080p.mkv');
      fs.writeFileSync(dest, 'old');

      const res = await h.service.ingest({
        mediaId: 7, files: [{ path: src }], transfer: 'copy',
        fallbackQuality: 'WEBDL-1080p', sourceLabel: 'x', replaceExisting: true,
      });
      expect(res.imported).toHaveLength(1);

      fs.writeFileSync(dest, 'new-bytes');
      const retry = await h.service.ingest({
        mediaId: 7, files: [{ path: src }], transfer: 'copy',
        fallbackQuality: 'WEBDL-1080p', sourceLabel: 'x', replaceExisting: true,
      });
      expect(retry.alreadyPresent).toEqual([src]);
    });

    it('keeps every other file without replaceExisting', async () => {
      const h = buildHarness();
      const src = path.join(srcDir, 'Lonely.Harbor.2021.mkv');
      fs.writeFileSync(src, 'x');
      h.mediaRepo.findOne.mockResolvedValue(buildMovie({ id: 7, path: libDir }));
      h.fileRepo.find.mockResolvedValue([{ id: 501, relativePath: 'old.mkv', episode: null }]);

      await h.service.ingest({
        mediaId: 7, files: [{ path: src }], transfer: 'copy',
        fallbackQuality: 'WEBDL-1080p', sourceLabel: 'x',
      });
      expect(h.mediaService.deleteMediaFile).not.toHaveBeenCalled();
    });
  });
});
