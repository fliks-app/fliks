import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { CompletionService } from './completion.service';
import { AcquisitionEventsService } from '../../modules/scheduler/acquisition-events.service';
import { NamingService } from '../../modules/scheduler/naming.service';
import { DownloadHistory } from './entities/download-history.entity';
import { Media } from '../../modules/media/entities/media.entity';
import { Library } from '../../modules/libraries/entities/library.entity';
import { QbittorrentTorrent } from './download-clients/qbittorrent.service';
import { TorrentHistoryMatcher } from './torrent-history-matcher.service';
import { FileTransferService } from '../../common/services/file-transfer.service';
import { LibraryIngestService } from '../../common/library-ingest/library-ingest.service';
import { MediaType } from '../../common/enums';

/** The exact stamp the orphan sweep writes — pinned here so the test guards
 *  the user-visible string the queue clears and re-applies. */
const ORPHAN_MESSAGE = 'Torrent no longer present in download client';

/**
 * `reconcileOrphanHistory` is private and only touches `historyRepo`,
 * `historyMatcher` and `log`, so we exercise it on a bare prototype instance
 * rather than standing up the 27-dependency constructor.
 */
function buildService(matchByHash: Set<string>) {
  const update = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn();
  const service = Object.create(CompletionService.prototype) as CompletionService;

  const matcher = {
    findMatch: (t: QbittorrentTorrent, histories: DownloadHistory[]) => {
      if (!t.hash || !matchByHash.has(t.hash)) return null;
      const history = histories.find((h) => h.torrentHash === t.hash);
      return history ? { history, matchedBy: 'hash' as const } : null;
    },
  } as unknown as TorrentHistoryMatcher;

  // Assign the few collaborators the method touches onto the bare instance.
  // Cast away `private readonly` since there's no constructor to set them.
  const wired = service as unknown as {
    historyRepo: unknown;
    historyMatcher: unknown;
    log: unknown;
    events: unknown;
    acquisitionEvents: unknown;
  };
  wired.historyRepo = { update };
  wired.historyMatcher = matcher;
  wired.log = { warn: jest.fn(), log: jest.fn() };
  wired.events = { emit };
  // `acquisitionEvents.publish` routes 'acquisition.queue.changed' straight
  // through `events.emit` — wire it onto the same mock the tests assert on.
  const acquisitionEvents = Object.create(
    AcquisitionEventsService.prototype,
  ) as AcquisitionEventsService;
  (acquisitionEvents as unknown as { events: unknown }).events = { emit };
  wired.acquisitionEvents = acquisitionEvents;
  return { service, update, emit };
}

function torrent(hash: string): QbittorrentTorrent {
  return { hash, name: hash, state: 'metaDL' } as QbittorrentTorrent;
}

function history(over: Partial<DownloadHistory>): DownloadHistory {
  return {
    id: 1,
    status: 'grabbed',
    torrentHash: 'h1',
    sourceTitle: 'h1',
    statusMessage: null as unknown as string,
    updatedAt: new Date(),
    ...over,
  } as DownloadHistory;
}

const HOUR_AGO = new Date(Date.now() - 60 * 60_000);

describe('CompletionService.reconcileOrphanHistory', () => {
  function run(
    torrents: QbittorrentTorrent[],
    rows: DownloadHistory[],
    importingRows: DownloadHistory[] = [],
  ) {
    const present = new Set(torrents.map((t) => t.hash));
    const { service, update, emit } = buildService(present);
    return {
      update,
      emit,
      done: (
        service as unknown as {
          reconcileOrphanHistory: (
            t: QbittorrentTorrent[],
            g: DownloadHistory[],
            i: DownloadHistory[],
          ) => Promise<void>;
        }
      ).reconcileOrphanHistory(torrents, rows, importingRows),
    };
  }

  it('flips a grabbed row to failed once its torrent is gone past the grace', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const { update, done } = run([], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([7], {
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
    });
  });

  it('leaves a grabbed row alone while its torrent is still present', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a freshly-grabbed missing torrent inside the grace window', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: new Date() });
    const { update, done } = run([], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the orphan stamp when the torrent reappears', async () => {
    const row = history({
      id: 9,
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([9], {
      status: 'grabbed',
      statusMessage: null,
    });
  });

  it('does not revive a row that failed for a different reason', async () => {
    const row = history({
      id: 9,
      status: 'failed',
      statusMessage: 'Stalled — removed by aggressive cleanup profile',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('flips an importing row to failed once its torrent is gone past the grace', async () => {
    const row = history({
      id: 12,
      status: 'importing',
      torrentHash: 'h2',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([], [], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([12], {
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
    });
  });

  it('leaves an importing row alone while its torrent is still present', async () => {
    const row = history({
      id: 12,
      status: 'importing',
      torrentHash: 'h2',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h2')], [], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('re-arms an importing row whose torrent went back to downloading', async () => {
    const row = history({ id: 21, status: 'importing', updatedAt: new Date() });
    const live = { ...torrent('h1'), progress: 0.1 } as QbittorrentTorrent;
    const { update, done } = run([live], [], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([21], {
      status: 'grabbed',
      statusMessage: null,
    });
  });

  it('leaves an importing row alone while its torrent is complete', async () => {
    const row = history({ id: 21, status: 'importing', updatedAt: new Date() });
    const done0 = { ...torrent('h1'), progress: 1 } as QbittorrentTorrent;
    const { update, done } = run([done0], [], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('emits queue.updated on a change, and stays silent when nothing moved', async () => {
    const gone = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const flip = run([], [gone]);
    await flip.done;
    expect(flip.emit).toHaveBeenCalledWith({ type: 'queue.updated' });

    const stillThere = history({ id: 8, status: 'grabbed', updatedAt: HOUR_AGO });
    const noop = run([torrent('h1')], [stillThere]);
    await noop.done;
    expect(noop.emit).not.toHaveBeenCalled();
  });
});

describe('CompletionService.autoMatchOrphanTorrents', () => {
  function run(rows: DownloadHistory[], name: string, hash: string) {
    const tryMatch = jest.fn().mockResolvedValue(null);
    const service = Object.create(CompletionService.prototype) as CompletionService;
    const wired = service as unknown as Record<string, unknown>;
    wired.historyRepo = { find: async () => rows, save: jest.fn(), create: jest.fn() };
    wired.autoMatcher = { tryMatch };
    wired.unidentifiedHashes = new Set<string>();
    wired.log = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    return {
      tryMatch,
      done: (
        service as unknown as {
          autoMatchOrphanTorrents: (t: unknown[]) => Promise<void>;
        }
      ).autoMatchOrphanTorrents([{ hash, name, _clientId: 1, _client: {} }]),
    };
  }

  it('trusts the linked row when a ghost row shares its hash', async () => {
    const { tryMatch, done } = run(
      [
        history({ id: 1, status: 'grabbed', torrentHash: 'h1' }),
        history({ id: 2, status: 'completed', torrentHash: 'h1', mediaId: 42 }),
        // Ghost last on purpose: insertion order must not decide the verdict.
        history({ id: 3, status: 'grabbed', torrentHash: 'h1' }),
      ],
      'Some.Release.1080p',
      'h1',
    );
    await done;
    expect(tryMatch).not.toHaveBeenCalled();
  });

  it('skips a torrent whose title is already bound to a media', async () => {
    const { tryMatch, done } = run(
      [
        history({
          id: 5,
          status: 'completed',
          torrentHash: null as unknown as string,
          sourceTitle: 'Some_Release_1080p',
          mediaId: 42,
        }),
      ],
      'Some.Release.1080p',
      'h9',
    );
    await done;
    expect(tryMatch).not.toHaveBeenCalled();
  });

  it('still tries to identify a torrent nothing accounts for', async () => {
    const { tryMatch, done } = run(
      [history({ id: 5, status: 'completed', torrentHash: 'other', mediaId: 42 })],
      'Unknown.Release.1080p',
      'h9',
    );
    await done;
    expect(tryMatch).toHaveBeenCalledWith('Unknown.Release.1080p');
  });
});

describe('CompletionService.cleanSeededTorrents', () => {
  const DAY_SEC = 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  /** Same bare-prototype approach as above, wiring only the collaborators
   *  `cleanSeededTorrents` reads. */
  function run(
    seeded: Partial<QbittorrentTorrent>,
    settings: Record<string, unknown>,
  ) {
    const deleteTorrent = jest.fn().mockResolvedValue(undefined);
    const service = Object.create(CompletionService.prototype) as CompletionService;
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      // Uppercase hash on purpose: rows written from an indexer-supplied hash
      // must still resolve against qBit's lowercase one.
      getMany: async () => [
        history({
          id: 3,
          status: 'completed',
          torrentHash: 'H1',
          indexerId: 5,
        }),
      ],
    };
    const wired = service as unknown as Record<string, unknown>;
    wired.clientRepo = { find: async () => [{ id: 1 }] };
    wired.qbittorrent = {
      supports: () => true,
      getTorrents: async () => [
        { hash: 'h1', name: 'pack', ratio: 0, completion_on: nowSec, ...seeded },
      ],
      deleteTorrent,
    };
    wired.historyRepo = { createQueryBuilder: () => qb };
    wired.indexerRepo = { find: async () => [{ id: 5, settings }] };
    wired.log = { log: jest.fn(), error: jest.fn() };
    const emit = jest.fn();
    wired.events = { emit };
    const acquisitionEvents = Object.create(
      AcquisitionEventsService.prototype,
    ) as AcquisitionEventsService;
    (acquisitionEvents as unknown as { events: unknown }).events = { emit };
    wired.acquisitionEvents = acquisitionEvents;
    return { deleteTorrent, done: service.cleanSeededTorrents() };
  }

  it('removes a torrent past its retention even when the ratio target is unmet', async () => {
    const { deleteTorrent, done } = run(
      { ratio: 0.1, completion_on: nowSec - 26 * DAY_SEC },
      { seedRatio: 1, maxRetentionDays: 2 },
    );
    await done;
    // Third arg = delete the payload files, not just the torrent entry.
    expect(deleteTorrent).toHaveBeenCalledWith({ id: 1 }, 'h1', true);
  });

  it('keeps a torrent that meets neither retention nor ratio', async () => {
    const { deleteTorrent, done } = run(
      { ratio: 0.1, completion_on: nowSec - DAY_SEC },
      { seedRatio: 1, maxRetentionDays: 2 },
    );
    await done;
    expect(deleteTorrent).not.toHaveBeenCalled();
  });

  it('still removes on the ratio target when no retention is configured', async () => {
    const { deleteTorrent, done } = run({ ratio: 1.5 }, { seedRatio: 1 });
    await done;
    expect(deleteTorrent).toHaveBeenCalledWith({ id: 1 }, 'h1', true);
  });
});

describe('CompletionService.processOne', () => {
  // Same 5 tokens `naming.getFormats()` returns when no admin override exists —
  // pinning real strings, not the defaults, is the point of these tests.
  const FORMATS = {
    movie: '{Movie Title} ({Release Year}) {Quality Full}',
    movieFolder: '{Movie Title} ({Release Year})',
    series:
      '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}',
    seriesFolder: '{Series Title}',
    seasonFolder: 'Season {season:00}',
  };

  function qbFile(name: string, size: number, progress = 1) {
    return { name, size, progress, priority: 1 };
  }

  function completedTorrent(over: Record<string, unknown>) {
    return {
      hash: 'hash1',
      name: 'Placeholder.Release-RELGRP',
      save_path: '/downloads/Placeholder.Release-RELGRP',
      _client: {},
      ...over,
    } as unknown as QbittorrentTorrent & { _client?: unknown };
  }

  function buildMedia(over: Record<string, unknown>): Media {
    // A real instance (not a cast object literal) so `media.path` — the
    // getter LibraryIngestService reads to derive the destination — works.
    return Object.assign(new Media(), {
      id: 1,
      title: 'placeholder title',
      originalTitle: undefined,
      year: undefined,
      type: MediaType.MOVIE,
      tmdbId: undefined,
      folderName: null,
      library: null,
      libraryId: null,
      ...over,
    });
  }

  /**
   * Wires every collaborator `processOne` (and the fire-and-forget
   * post-import tasks it kicks off) touches, on a bare prototype instance —
   * same approach as the other describe blocks in this file. `naming` is the
   * real service (pure/sync for the methods used here) so destination
   * strings are pinned against real formatting logic, not a stand-in.
   *
   * The destination-path/write/persistence work now lives in
   * `LibraryIngestService` (also a bare prototype instance here), so most
   * collaborators below are wired onto IT rather than onto `service`
   * directly — `processOne` only keeps the media/history/episode
   * bookkeeping around the single `libraryIngest.ingest()` call.
   */
  function buildProcessOneHarness() {
    const service = Object.create(CompletionService.prototype) as CompletionService;
    const libraryIngest = Object.create(
      LibraryIngestService.prototype,
    ) as LibraryIngestService;

    const mediaRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mediaFileRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => ({ id: 999, ...(x as object) })),
    };
    const historyRepo = { update: jest.fn().mockResolvedValue(undefined) };
    const seasonRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const episodeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const qbittorrent = {
      getTorrentFiles: jest.fn().mockResolvedValue([]),
      deleteTorrent: jest.fn().mockResolvedValue(undefined),
    };
    const blocklist = { createFromHistory: jest.fn().mockResolvedValue(undefined) };
    // 'false' short-circuits autoDetectMarkersOnImport so the marker-detection
    // background task never touches episodeRepo/seasonRepo a second time.
    const settings = { get: jest.fn().mockResolvedValue('false') };
    const sseAudience = { recipientsForMedia: jest.fn().mockResolvedValue([]) };
    const events = { emit: jest.fn(), emitToUsers: jest.fn(), emitDomain: jest.fn() };
    const ffprobe = {
      detectMediaFileInfo: jest
        .fn()
        .mockResolvedValue({ video: [], audio: [], subtitles: [] }),
    };
    const fileTransfer = {
      transferFile: jest.fn().mockResolvedValue(undefined),
      transferCompanions: jest.fn().mockResolvedValue(undefined),
      getCompanionExts: jest.fn().mockResolvedValue(new Set<string>()),
    };
    const notifications = { dispatch: jest.fn() };
    const mediaServers = { dispatch: jest.fn() };
    const mediaService = {
      finalizeImportedFile: jest.fn().mockResolvedValue(undefined),
    };
    const subtitleScheduler = {
      onMediaFileImported: jest.fn().mockResolvedValue(undefined),
    };
    const markers = { detectSeason: jest.fn().mockResolvedValue(undefined) };
    const thumbnailService = {
      generateForFile: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const log = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    // Stubbed `query` (unlike the other describe blocks' bare `{}`): ingest
    // now calls `naming.getFormats()` itself, which round-trips through
    // `dataSource.query` before falling back to the same defaults as FORMATS.
    const naming = new NamingService({
      query: jest.fn().mockResolvedValue([]),
    } as unknown as DataSource);

    // `AcquisitionEventsService` now owns the sseAudience/events/notifications/
    // mediaServers fan-out `processOne` used to do inline — wire a bare
    // instance over the same mocks, same approach as `libraryIngest` below.
    const acquisitionEvents = Object.create(
      AcquisitionEventsService.prototype,
    ) as AcquisitionEventsService;
    const acquisitionEventsWired = acquisitionEvents as unknown as Record<
      string,
      unknown
    >;
    acquisitionEventsWired.events = events;
    acquisitionEventsWired.sseAudience = sseAudience;
    acquisitionEventsWired.notifications = notifications;
    acquisitionEventsWired.mediaServers = mediaServers;

    const wired = service as unknown as Record<string, unknown>;
    wired.mediaRepo = mediaRepo;
    wired.historyRepo = historyRepo;
    wired.seasonRepo = seasonRepo;
    wired.episodeRepo = episodeRepo;
    wired.qbittorrent = qbittorrent;
    wired.blocklist = blocklist;
    wired.settings = settings;
    wired.sseAudience = sseAudience;
    wired.events = events;
    wired.acquisitionEvents = acquisitionEvents;
    wired.markers = markers;
    wired.thumbnailService = thumbnailService;
    wired.dataSource = dataSource;
    wired.log = log;
    wired.naming = naming;
    wired.libraryIngest = libraryIngest;

    const ingestWired = libraryIngest as unknown as Record<string, unknown>;
    ingestWired.mediaRepo = mediaRepo;
    ingestWired.fileRepo = mediaFileRepo;
    ingestWired.episodeRepo = episodeRepo;
    ingestWired.seasonRepo = seasonRepo;
    ingestWired.naming = naming;
    ingestWired.fileTransfer = fileTransfer;
    ingestWired.mediaService = mediaService;
    ingestWired.subtitleScheduler = subtitleScheduler;
    ingestWired.ffprobe = ffprobe;
    ingestWired.logger = log;
    ingestWired.events = events;

    const run = (
      historyRow: DownloadHistory,
      torrentRow: QbittorrentTorrent & { _client?: unknown },
      mediaRow: Media,
      libraries: Library[] = [],
    ) => {
      mediaRepo.findOne.mockResolvedValue(mediaRow);
      return (
        service as unknown as {
          processOne: (...args: unknown[]) => Promise<void>;
        }
      ).processOne(
        historyRow,
        torrentRow,
        FORMATS.movieFolder,
        FORMATS.seriesFolder,
        libraries,
      );
    };

    return {
      service,
      libraryIngest,
      run,
      mediaRepo,
      mediaFileRepo,
      historyRepo,
      seasonRepo,
      episodeRepo,
      qbittorrent,
      blocklist,
      sseAudience,
      events,
      ffprobe,
      fileTransfer,
      notifications,
      mediaServers,
      mediaService,
      subtitleScheduler,
      markers,
      thumbnailService,
      dataSource,
      log,
    };
  }

  /** Wires the two-episode season-pack fixture shared by the "own episode per
   *  file" and "history reconciliation" tests below. `LibraryIngestService`
   *  hits `episodeRepo.findOne` with two different query shapes depending on
   *  whether the file arrives with a caller-resolved `episodeId` (`{ id }`)
   *  or needs parsing from the filename (`{ season, episodeNumber }`). Both
   *  must resolve to the same two episodes. */
  function wireSeasonPack(h: ReturnType<typeof buildProcessOneHarness>) {
    const episodesById: Record<number, Record<string, unknown>> = {
      601: {
        id: 601,
        episodeNumber: 1,
        title: 'Wake',
        airDate: '2019-01-01',
        endEpisodeNumber: null,
        season: { seasonNumber: 1 },
      },
      602: {
        id: 602,
        episodeNumber: 2,
        title: 'Drift',
        airDate: '2019-01-08',
        endEpisodeNumber: null,
        season: { seasonNumber: 1 },
      },
    };
    const idByEpisodeNumber: Record<number, number> = { 1: 601, 2: 602 };
    h.episodeRepo.findOne.mockImplementation(
      async (opts: { where?: { id?: number; episodeNumber?: number } }) => {
        if (opts.where?.id != null) return episodesById[opts.where.id] ?? null;
        if (opts.where?.episodeNumber != null) {
          const id = idByEpisodeNumber[opts.where.episodeNumber];
          return id != null ? episodesById[id] : null;
        }
        return null;
      },
    );
    h.seasonRepo.findOne.mockResolvedValue({ id: 20, seasonNumber: 1 });
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('Skyline.Signals.S01E01.1080p.WEB-DL-RELGRP.mkv', 100),
      qbFile('Skyline.Signals.S01E02.1080p.WEB-DL-RELGRP.mkv', 200),
    ]);
    const seriesMedia = buildMedia({
      id: 2,
      title: 'Skyline Signals',
      type: MediaType.SERIES,
      year: 2019,
      library: { id: 11, path: '/media/shows' },
      libraryId: 11,
    });
    const historyRow = history({
      id: 70,
      mediaId: 2,
      sourceTitle: 'Skyline.Signals.S01.1080p.WEB-DL-RELGRP',
      quality: 'WEBDL-1080p',
    });
    const torrentRow = completedTorrent({
      hash: 'hseason',
      name: historyRow.sourceTitle,
      save_path: '/downloads/Skyline.Signals.S01.1080p.WEB-DL-RELGRP',
    });
    return { seriesMedia, historyRow, torrentRow };
  }

  it('imports the largest video file for a movie and ignores non-video extensions', async () => {
    const h = buildProcessOneHarness();
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP.mkv', 500),
      qbFile('Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP.proof.mp4', 9000),
      qbFile('Sample/Nova.Skyline.Sample.mkv', 50),
      qbFile('Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP.nfo', 2000),
      qbFile('RARBG.txt', 100),
    ]);
    const movieMedia = buildMedia({
      id: 1,
      title: 'Nova Skyline',
      year: 2023,
      library: { id: 10, path: '/library/movies' },
      libraryId: 10,
    });
    const historyRow = history({
      id: 40,
      mediaId: 1,
      sourceTitle: 'Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP',
      quality: 'WEBDL-2160p',
    });
    const torrentRow = completedTorrent({
      hash: 'h40',
      name: historyRow.sourceTitle,
      save_path: '/downloads/Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP',
    });

    await h.run(historyRow, torrentRow, movieMedia);

    expect(h.fileTransfer.transferFile).toHaveBeenCalledTimes(1);
    expect(h.fileTransfer.transferFile).toHaveBeenCalledWith(
      '/downloads/Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP/Nova.Skyline.2023.2160p.WEB-DL.x265-RELGRP.proof.mp4',
      '/library/movies/Nova Skyline (2023)/Nova Skyline (2023) WEBDL-2160p.mp4',
      'copy',
    );
    expect(h.mediaRepo.update).toHaveBeenCalledWith(1, {
      folderName: 'Nova Skyline (2023)',
    });
    expect(h.mediaFileRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'Nova Skyline (2023) WEBDL-2160p.mp4',
        size: 9000,
        quality: 'WEBDL-2160p',
        episode: null,
      }),
    );
    expect(h.historyRepo.update).toHaveBeenCalledWith(historyRow.id, {
      status: 'completed',
    });
  });

  it("fails the import when none of the torrent's files carry a video extension", async () => {
    const h = buildProcessOneHarness();
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('NoVideo.Release.2024.rar', 900_000),
      qbFile('NoVideo.Release.2024.r00', 900_000),
      qbFile('NoVideo.Release.2024.nfo', 5_000),
      qbFile('NoVideo.Release.2024.txt', 100),
      qbFile('Sample.iso', 800_000),
    ]);
    const historyRow = history({
      id: 41,
      mediaId: 1,
      sourceTitle: 'NoVideo.Release.2024-RELGRP',
      quality: 'HDTV-720p',
    });
    const torrentRow = completedTorrent({
      hash: 'h41',
      name: 'NoVideo.Release.2024',
      save_path: '/downloads/NoVideo.Release.2024',
    });

    await h.run(historyRow, torrentRow, buildMedia({}));

    expect(h.mediaRepo.findOne).not.toHaveBeenCalled();
    const statusMessage =
      'Import failed: no valid video file in the download "NoVideo.Release.2024"';
    expect(h.historyRepo.update).toHaveBeenCalledWith(historyRow.id, {
      status: 'failed',
      statusMessage,
    });
    expect(h.blocklist.createFromHistory).toHaveBeenCalledWith(
      historyRow,
      'Auto-blocklist: no valid video file in the download',
    );
    expect(h.qbittorrent.deleteTorrent).toHaveBeenCalledWith(
      torrentRow._client,
      torrentRow.hash,
      true,
    );
    expect(h.events.emitToUsers).toHaveBeenCalledWith([], {
      type: 'import.failed',
      mediaId: historyRow.mediaId,
      title: historyRow.sourceTitle,
      error: statusMessage,
    });
    expect(h.events.emit).toHaveBeenCalledWith({ type: 'queue.updated' });
  });

  it('imports each video file of a series season pack as its own episode under its season folder', async () => {
    const h = buildProcessOneHarness();
    const { seriesMedia, historyRow, torrentRow } = wireSeasonPack(h);

    await h.run(historyRow, torrentRow, seriesMedia);

    const destDir = '/media/shows/Skyline Signals/Season 01';
    expect(h.fileTransfer.transferFile).toHaveBeenNthCalledWith(
      1,
      '/downloads/Skyline.Signals.S01.1080p.WEB-DL-RELGRP/Skyline.Signals.S01E01.1080p.WEB-DL-RELGRP.mkv',
      `${destDir}/Skyline Signals - S01E01 - Wake WEBDL-1080p.mkv`,
      'copy',
    );
    expect(h.fileTransfer.transferFile).toHaveBeenNthCalledWith(
      2,
      '/downloads/Skyline.Signals.S01.1080p.WEB-DL-RELGRP/Skyline.Signals.S01E02.1080p.WEB-DL-RELGRP.mkv',
      `${destDir}/Skyline Signals - S01E02 - Drift WEBDL-1080p.mkv`,
      'copy',
    );
    expect(h.mediaFileRepo.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        relativePath: 'Season 01/Skyline Signals - S01E01 - Wake WEBDL-1080p.mkv',
        episode: { id: 601 },
      }),
    );
    expect(h.mediaFileRepo.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        relativePath: 'Season 01/Skyline Signals - S01E02 - Drift WEBDL-1080p.mkv',
        episode: { id: 602 },
      }),
    );
  });

  it('prefers the resolution-derived quality over a mislabeled release-name grab', async () => {
    const h = buildProcessOneHarness();
    h.ffprobe.detectMediaFileInfo.mockResolvedValue({
      video: [{ width: 1920, height: 804 }],
      audio: [],
      subtitles: [],
    });
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP.mkv', 700),
    ]);
    const movieMedia = buildMedia({
      id: 4,
      title: 'Halcyon Reach',
      year: 2024,
      library: { id: 12, path: '/library/movies2' },
      libraryId: 12,
    });
    const historyRow = history({
      id: 90,
      mediaId: 4,
      sourceTitle: 'Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP',
      quality: 'WEBDL-2160p',
    });
    const torrentRow = completedTorrent({
      hash: 'hq1',
      name: historyRow.sourceTitle,
      save_path: '/downloads/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP',
    });

    await h.run(historyRow, torrentRow, movieMedia);

    expect(h.fileTransfer.transferFile).toHaveBeenCalledWith(
      '/downloads/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP.mkv',
      '/library/movies2/Halcyon Reach (2024)/Halcyon Reach (2024) WEBDL-1080p.mkv',
      'copy',
    );
    expect(h.mediaFileRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 'WEBDL-1080p' }),
    );
  });

  it('falls back to the grabbed quality when ffprobe reports no dimensions', async () => {
    const h = buildProcessOneHarness();
    // Default ffprobe mock already resolves an empty video array.
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP.mkv', 700),
    ]);
    const movieMedia = buildMedia({
      id: 4,
      title: 'Halcyon Reach',
      year: 2024,
      library: { id: 12, path: '/library/movies2' },
      libraryId: 12,
    });
    const historyRow = history({
      id: 91,
      mediaId: 4,
      sourceTitle: 'Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP',
      quality: 'HDTV-720p',
    });
    const torrentRow = completedTorrent({
      hash: 'hq2',
      name: historyRow.sourceTitle,
      save_path: '/downloads/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP',
    });

    await h.run(historyRow, torrentRow, movieMedia);

    expect(h.fileTransfer.transferFile).toHaveBeenCalledWith(
      '/downloads/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP/Halcyon.Reach.2024.2160p.WEB-DL.x265-RELGRP.mkv',
      '/library/movies2/Halcyon Reach (2024)/Halcyon Reach (2024) HDTV-720p.mkv',
      'copy',
    );
    expect(h.mediaFileRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 'HDTV-720p' }),
    );
  });

  it('copies an allow-listed companion file and skips one outside the allow-list', async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-src-'));
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-root-'));
    try {
      const videoName = 'Nova.Skyline.2023.1080p.WEB-DL-RELGRP.mkv';
      fs.writeFileSync(path.join(srcDir, videoName), 'video-bytes');
      fs.writeFileSync(
        path.join(srcDir, 'Nova.Skyline.2023.1080p.WEB-DL-RELGRP.srt'),
        'subtitle',
      );
      fs.writeFileSync(
        path.join(srcDir, 'Nova.Skyline.2023.1080p.WEB-DL-RELGRP.txt'),
        'readme',
      );

      const h = buildProcessOneHarness();
      // Real FileTransferService for this one test — the allow-list filtering
      // it does is exactly what's being pinned, a mock would hide it. Lives
      // on the ingest instance now: that's what actually calls it.
      (h.libraryIngest as unknown as { fileTransfer: unknown }).fileTransfer =
        new FileTransferService(
          { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
        );
      h.qbittorrent.getTorrentFiles.mockResolvedValue([qbFile(videoName, 12)]);
      const movieMedia = buildMedia({
        id: 5,
        title: 'Nova Skyline',
        year: 2023,
        library: { id: 13, path: rootDir },
        libraryId: 13,
      });
      const historyRow = history({
        id: 100,
        mediaId: 5,
        sourceTitle: 'Nova.Skyline.2023.1080p.WEB-DL-RELGRP',
        quality: 'WEBDL-1080p',
      });
      const torrentRow = completedTorrent({
        hash: 'hcompanion',
        name: historyRow.sourceTitle,
        save_path: srcDir,
      });

      await h.run(historyRow, torrentRow, movieMedia);

      const destDir = path.join(rootDir, 'Nova Skyline (2023)');
      expect(
        fs.existsSync(path.join(destDir, 'Nova Skyline (2023) WEBDL-1080p.mkv')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(destDir, 'Nova Skyline (2023) WEBDL-1080p.srt')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(destDir, 'Nova Skyline (2023) WEBDL-1080p.txt')),
      ).toBe(false);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('pins both season and episode on the history row when a single episode imports', async () => {
    const h = buildProcessOneHarness();
    h.seasonRepo.findOne.mockResolvedValue({ id: 30, seasonNumber: 1 });
    h.episodeRepo.findOne.mockResolvedValue({
      id: 900,
      episodeNumber: 5,
      title: 'Signal Lost',
      airDate: '2019-02-01',
      endEpisodeNumber: null,
    });
    h.qbittorrent.getTorrentFiles.mockResolvedValue([
      qbFile('Skyline.Signals.S01E05.HDTV.x264-RELGRP.mkv', 400),
    ]);
    const seriesMedia = buildMedia({
      id: 3,
      title: 'Skyline Signals',
      type: MediaType.SERIES,
      year: 2019,
      library: { id: 11, path: '/media/shows' },
      libraryId: 11,
    });
    const historyRow = history({
      id: 80,
      mediaId: 3,
      sourceTitle: 'Skyline.Signals.S01E05.HDTV.x264-RELGRP',
      quality: 'HDTV-720p',
    });
    const torrentRow = completedTorrent({
      hash: 'hsingle',
      name: historyRow.sourceTitle,
      save_path: '/downloads/Skyline.Signals.S01E05.HDTV.x264-RELGRP',
    });

    await h.run(historyRow, torrentRow, seriesMedia);

    expect(h.historyRepo.update).toHaveBeenCalledWith(historyRow.id, {
      status: 'completed',
      episode: { id: 900 },
      season: { id: 30 },
    });
    expect(h.episodeRepo.update).toHaveBeenCalledWith(900, { hasFile: true });
  });

  it('pins the season and clears the episode on the history row when a season pack imports', async () => {
    const h = buildProcessOneHarness();
    const { seriesMedia, historyRow, torrentRow } = wireSeasonPack(h);

    await h.run(historyRow, torrentRow, seriesMedia);

    expect(h.historyRepo.update).toHaveBeenCalledWith(historyRow.id, {
      status: 'completed',
      episode: null,
      season: { id: 20 },
    });
  });
});
