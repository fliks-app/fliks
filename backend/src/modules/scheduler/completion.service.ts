import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import * as path from 'path';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import {
  QbittorrentService,
  QbittorrentTorrent,
} from '../download-clients/qbittorrent.service';
import { Indexer } from '../indexers/entities/indexer.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NamingService } from './naming.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { EventsService } from './events.service';
import { SseAudienceService } from './sse-audience.service';
import { SettingsService } from '../settings/settings.service';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { MediaServersService } from '../media-servers/media-servers.service';
import { FfprobeService } from '../subtitles/ffprobe.service';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../streaming/thumbnail.service';
import { MediaType } from '../../common/enums';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { StalledCheck } from './entities/stalled-check.entity';
import { CleanupProfile } from '../cleanup-profiles/entities/cleanup-profile.entity';
import { Library } from '../libraries/entities/library.entity';
import { TorrentHistoryMatcher } from '../media/torrent-history-matcher.service';
import { TorrentAutoMatcher } from '../media/torrent-auto-matcher.service';
import { buildGrabHistoryRow } from '../media/grab-history.util';
import { parseReleaseQuality } from '../../common/release-parsing';
import { MarkersService } from '../markers/markers.service';
import { FileTransferService } from '../../common/services/file-transfer.service';
import { MediaService } from '../media/media.service';

/**
 * How long a `grabbed` history row may stay without a matching qBit
 * torrent before we mark it `failed`. Picked at 30 min so a transient
 * mismatch (HTML-entity decode drift between qBit and the indexer's raw
 * title, a brief qBit unavailability, a torrent rename mid-tick) can't
 * trip the orphan handler. The row is NEVER deleted; only its status
 * flips so the user sees the failure in Activities and can re-grab.
 */
const ORPHAN_GRACE_MS = 30 * 60_000;

@Injectable()
export class CompletionService {
  private readonly log = new Logger(CompletionService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(StalledCheck)
    private readonly stalledCheckRepo: Repository<StalledCheck>,
    @InjectRepository(CleanupProfile)
    private readonly cleanupProfileRepo: Repository<CleanupProfile>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly qbittorrent: QbittorrentService,
    private readonly notifications: NotificationsService,
    private readonly naming: NamingService,
    private readonly blocklist: BlocklistService,
    private readonly settings: SettingsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly mediaServers: MediaServersService,
    private readonly events: EventsService,
    private readonly ffprobe: FfprobeService,
    private readonly thumbnailService: ThumbnailService,
    private readonly historyMatcher: TorrentHistoryMatcher,
    private readonly autoMatcher: TorrentAutoMatcher,
    private readonly fileTransfer: FileTransferService,
    private readonly markers: MarkersService,
    private readonly sseAudience: SseAudienceService,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Whether series imports trigger automatic intro / outro marker
   * detection. Default on — most users want skip-intro working right
   * after a series finishes downloading.
   *
   * TODO(#212): replace with an awaited `SettingsService.get(...)` read
   * so the admin can opt out from the UI. Default stays `true`.
   */
  private autoDetectMarkersOnImport(): boolean {
    return true;
  }

  /**
   * For every torrent currently in qBit that has no corresponding
   * `DownloadHistory` row (matched neither by hash nor by sourceTitle
   * fallback), attempt to identify its media via
   * {@link TorrentAutoMatcher} and create a fresh history row.
   *
   * Mutates `grabbed` in place to include any newly-created rows so
   * the caller's downstream loops treat them like normal grab rows.
   *
   * Skips torrents whose hash is already referenced by ANY history row
   * (including `completed` / `imported`) to avoid duplicating rows for
   * torrents we've already processed.
   */
  private async autoMatchOrphanTorrents(
    allTorrents: ReadonlyArray<
      QbittorrentTorrent & { _clientId: number; _client: DownloadClient }
    >,
  ): Promise<void> {
    if (!allTorrents.length) return;

    // Index every history row by its hash so we can tell apart:
    //  - "no row at all"            → create one.
    //  - "row exists, media linked" → already handled by the main matcher.
    //  - "row exists, media NULL"   → rebind the existing row (anomalous
    //    state from past bugs; we cannot SQL-diagnose so we heal at
    //    runtime). Updating instead of inserting keeps the row's
    //    original \`createdAt\` / status history.
    const allHistory = await this.historyRepo.find({
      relations: ['media'],
    });
    const rowByHash = new Map<string, DownloadHistory>();
    const activeHistory = allHistory.filter(
      (h) =>
        h.status === 'grabbed' ||
        h.status === 'failed' ||
        h.status === 'warning',
    );
    for (const h of allHistory) {
      if (h.torrentHash) rowByHash.set(h.torrentHash.toLowerCase(), h);
    }

    const candidates = allTorrents.filter((t) => {
      if (!t.hash) return false;
      const existing = rowByHash.get(t.hash.toLowerCase());
      if (!existing) return true; // No row → candidate (create).
      if (!existing.mediaId) return true; // Row but unlinked → candidate (rebind).
      return false; // Row already linked → skip.
    });
    if (!candidates.length) {
      this.log.debug?.(
        `Auto-match: ${allTorrents.length} qBit torrents, all already linked — nothing to do`,
      );
      return;
    }
    this.log.log(
      `Auto-match: scanning ${candidates.length}/${allTorrents.length} torrent(s) without a media link`,
    );

    let bound = 0;
    let rebound = 0;
    let skippedByNameFallback = 0;
    let unidentified = 0;
    for (const torrent of candidates) {
      const existingRow = rowByHash.get(torrent.hash!.toLowerCase());

      // Belt-and-braces: name-fallback against currently-active rows.
      // Only skip if that match actually has a media reference — a
      // \`mediaId IS NULL\` ghost row would otherwise prevent the heal.
      const fallback = this.historyMatcher.findMatch(torrent, activeHistory);
      if (fallback?.history.mediaId) {
        skippedByNameFallback++;
        continue;
      }

      let match;
      try {
        match = await this.autoMatcher.tryMatch(torrent.name);
      } catch (err) {
        this.log.warn(
          `Auto-match: tryMatch threw on "${torrent.name}": ${(err as Error).message}`,
        );
        continue;
      }
      if (!match) {
        unidentified++;
        this.log.log(
          `Auto-match: "${torrent.name}" — no media in library matches the parsed title (ambiguous or unknown)`,
        );
        continue;
      }

      const quality = parseReleaseQuality(torrent.name).quality.name;
      const seasonId =
        match.season?.id ?? match.episode?.season?.id ?? null;
      const episodeId = match.episode?.id ?? null;

      let row: DownloadHistory;
      if (existingRow) {
        // Heal the existing orphan: assign the media + episode/season,
        // bump quality + sourceTitle (decoded) so the next tick's
        // matcher sees a clean row. Status / createdAt / grabSource
        // are left intact — this is restoration, not a new grab.
        existingRow.media = match.media;
        existingRow.episode = match.episode ?? null;
        existingRow.season =
          match.season ?? match.episode?.season ?? null;
        existingRow.quality = quality;
        row = await this.historyRepo.save(existingRow);
        rebound++;
      } else {
        row = await this.historyRepo.save(
          this.historyRepo.create(
            buildGrabHistoryRow({
              media: match.media,
              downloadClient: torrent._client,
              sourceTitle: torrent.name,
              torrentHash: torrent.hash,
              quality,
              // Auto-matched orphans look closer to a manual add (the
              // user put the torrent in qBit, we just figured out which
              // media it belongs to) than to a scheduler auto-grab.
              grabSource: 'manual',
              episodeId,
              seasonId,
            }),
          ),
        );
        bound++;
      }

      const epLabel = match.episode
        ? ` ${match.season ? `S${String(match.season.seasonNumber).padStart(2, '0')}` : ''}E${String(match.episode.episodeNumber).padStart(2, '0')}`
        : match.season
          ? ` Season ${match.season.seasonNumber}`
          : '';
      const verb = existingRow ? 'rebound' : 'bound';
      this.log.log(
        `Auto-match: ${verb} torrent "${torrent.name}" → ${match.media.title}${epLabel} (history #${row.id})`,
      );
    }
    this.log.log(
      `Auto-match: done — ${bound} created, ${rebound} healed, ${skippedByNameFallback} matched by name (will heal hash), ${unidentified} unidentified`,
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processCompleted(): Promise<void> {
    // Source of truth = qBittorrent. We iterate over the torrents qBit
    // reports, resolve each to its single canonical `DownloadHistory`
    // row, then import the completed ones. The previous flow was
    // history-centric (iterate every grabbed row, look for a matching
    // torrent) which O(n)-loops over every legacy duplicate every
    // minute. After migration 1779500000000 collapsed the legacy
    // duplicates the matcher returns exactly one row per torrent and
    // the loop is bounded by the qBit-torrent count.
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) {
      this.log.warn('Import: no enabled qBittorrent client found');
      return;
    }

    const allTorrents = (
      await Promise.all(
        qbitClients.map(async (c) => {
          const torrents = await this.qbittorrent.getTorrents(c);
          return torrents.map((t) => ({ ...t, _clientId: c.id, _client: c }));
        }),
      )
    ).flat();

    // Phase 1 — auto-match orphan torrents (creates history rows for
    // qBit torrents that have no DB linkage yet).
    await this.autoMatchOrphanTorrents(allTorrents);

    // Load active rows AFTER auto-match so freshly-created rows are
    // included. `failed` and `warning` rows stay candidates so a user
    // who fixes the underlying issue (renamed file, edited library
    // path…) just has to wait one tick.
    const grabbed = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'warning' },
      ],
    });

    // Phase 2 — orphan-history sweep: rows whose torrent has vanished
    // from qBit for longer than the grace period flip to `failed`.
    // Media link is preserved.
    await this.markStaleHistoryAsFailed(allTorrents, grabbed);

    // Phase 3 — import the completed torrents.
    const completedTorrents = allTorrents.filter(
      (t) =>
        t.progress >= 1 ||
        t.state === 'seeding' ||
        t.state === 'stalledUP' ||
        t.state === 'stoppedUP',
    );
    if (!completedTorrents.length) return;

    const formats = await this.naming.getFormats();
    const movieFormat = formats.movie;
    const movieFolderFormat = formats.movieFolder;
    const seriesFormat = formats.series;
    const seriesFolderFormat = formats.seriesFolder;
    const seasonFolderFormat = formats.seasonFolder;
    const libraries = await this.libraryRepo.find({ order: { path: 'ASC' } });

    let imported = 0;
    for (const torrent of completedTorrents) {
      const history = await this.historyMatcher.matchAndHeal(torrent, grabbed);
      if (!history) continue;
      // Already imported or in flight: leave alone.
      if (
        history.status !== 'grabbed' &&
        history.status !== 'failed' &&
        history.status !== 'warning'
      ) {
        continue;
      }

      this.log.log(
        `Import: torrent "${torrent.name}" → history #${history.id} (mediaId=${history.mediaId}, status=${history.status})`,
      );

      try {
        await this.historyRepo.update(history.id, { status: 'importing' });
        await this.processOne(
          history,
          torrent,
          movieFormat,
          movieFolderFormat,
          seriesFormat,
          seriesFolderFormat,
          seasonFolderFormat,
          libraries,
        );
        imported++;
      } catch (e) {
        this.log.error(
          `Import: FAILED for "${history.sourceTitle}": ${(e as Error).message}`,
        );
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage: (e as Error).message,
        });

        const failRecipients = await this.sseAudience.recipientsForMedia(
          history.mediaId,
        );
        this.events.emitToUsers(failRecipients, {
          type: 'import.failed',
          mediaId: history.mediaId,
          title: history.sourceTitle,
          error: (e as Error).message,
        });
        this.events.emit({ type: 'queue.updated' });

        // Auto-blocklist the failed release so it won't be grabbed again
        try {
          await this.blocklist.create({
            sourceTitle: history.sourceTitle,
            quality: history.quality,
            mediaId: history.mediaId,
            indexerId: history.indexerId ?? undefined,
            note: `Auto-blocklist: import failed — ${(e as Error).message}`,
          });
          this.log.log(`Import: auto-blocklisted "${history.sourceTitle}"`);
        } catch {
          // ignore blocklist errors
        }
      }
    }
    if (imported > 0) {
      this.log.log(
        `Import: processed ${imported}/${completedTorrents.length} completed torrent(s)`,
      );
    }
  }

  /**
   * Flip history rows to `failed` when their torrent has been missing
   * from qBit for at least {@link ORPHAN_GRACE_MS}. Extracted here so
   * `processCompleted` reads as three crisp phases. The grace is
   * measured off `updatedAt` because every status / hash heal write
   * bumps it; a row whose torrent just arrived in qBit has a fresh
   * timestamp and won't be flipped.
   */
  private async markStaleHistoryAsFailed(
    allTorrents: ReadonlyArray<QbittorrentTorrent>,
    grabbed: DownloadHistory[],
  ): Promise<void> {
    if (!grabbed.length) return;
    const matchedHistoryIds = new Set<number>();
    for (const t of allTorrents) {
      const m = this.historyMatcher.findMatch(t, grabbed);
      if (m) matchedHistoryIds.add(m.history.id);
    }
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const expired = grabbed.filter(
      (h) =>
        h.status === 'grabbed' &&
        !matchedHistoryIds.has(h.id) &&
        h.updatedAt.getTime() < cutoff,
    );
    if (!expired.length) return;
    await this.historyRepo.update(
      expired.map((h) => h.id),
      {
        status: 'failed',
        statusMessage: 'Torrent no longer present in download client',
      },
    );
    this.log.warn(
      `Import: ${expired.length} grabbed entries lost their torrent in qBittorrent for > ${ORPHAN_GRACE_MS / 60_000}min — marked failed (media link preserved)`,
    );
  }

  private async processOne(
    history: DownloadHistory,
    torrent: QbittorrentTorrent & {
      _clientId?: number;
      _client?: import('../download-clients/entities/download-client.entity').DownloadClient;
    },
    movieFormat: string,
    movieFolderFormat: string,
    seriesFormat: string,
    seriesFolderFormat: string,
    seasonFolderFormat: string,
    libraries: Library[],
  ): Promise<void> {
    const VIDEO_EXTS = [
      '.mkv',
      '.mp4',
      '.avi',
      '.mov',
      '.ts',
      '.m2ts',
      '.wmv',
      '.flv',
    ];

    // Use qBittorrent API to get actual files of this torrent
    const videoFiles: { filePath: string; size: number }[] = [];

    if (torrent._client) {
      const torrentFiles = await this.qbittorrent.getTorrentFiles(
        torrent._client,
        torrent.hash,
      );
      for (const f of torrentFiles) {
        const ext = path.extname(f.name).toLowerCase();
        if (VIDEO_EXTS.includes(ext) && f.progress >= 1) {
          const filePath = path.join(torrent.save_path, f.name);
          videoFiles.push({ filePath, size: f.size });
        }
      }
      this.log.log(
        `Import[${history.sourceTitle}]: qBittorrent API returned ${torrentFiles.length} file(s), ${videoFiles.length} video(s)`,
      );
    }

    if (!videoFiles.length) {
      const statusMessage = `Import blocked: no valid video file found for "${torrent.name}"`;
      this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.historyRepo.update(history.id, {
        status: 'warning',
        statusMessage,
      });
      return;
    }

    this.log.log(
      `Import[${history.sourceTitle}]: found ${videoFiles.length} video file(s)`,
    );

    const media = await this.mediaRepo.findOne({
      where: { id: history.mediaId },
      relations: ['library'],
    });
    if (!media) {
      this.log.warn(
        `Import[${history.sourceTitle}]: media id=${history.mediaId} not found in DB`,
      );
      return;
    }
    this.log.log(
      `Import[${history.sourceTitle}]: media="${media.title}" (${media.type}, id=${media.id})`,
    );

    const releaseGroup = this.naming.extractReleaseGroup(history.sourceTitle);

    // Destination root folder (just the root, without folderName — folderName
    // is appended separately when building destDir).
    let rootPath = media.library?.path ?? '';
    let resolvedLib = media.library ?? null;
    if (!rootPath) {
      const fallback = libraries.find((l) => !!l.path);
      if (!fallback) {
        this.log.warn(
          `Import[${history.sourceTitle}]: no library path configured, skipping`,
        );
        return;
      }
      resolvedLib = fallback;
      rootPath = fallback.path!;
      this.log.log(
        `Import[${history.sourceTitle}]: no path on media, falling back to library "${fallback.name}" (${rootPath})`,
      );
    }

    // Ensure folderName is set
    const folderName =
      media.folderName ||
      (media.type === MediaType.MOVIE
        ? this.naming.applyMovieFolderFormat(movieFolderFormat, {
            title: media.title,
            originalTitle: media.originalTitle,
            year: media.year,
            tmdbId: media.tmdbId,
          })
        : this.naming.applySeriesFolderFormat(seriesFolderFormat, {
            seriesTitle: media.title,
            originalTitle: media.originalTitle,
            year: media.year,
            tmdbId: media.tmdbId,
          }));
    if (!media.folderName) {
      await this.mediaRepo.update(media.id, { folderName });
    }

    // Pin the library on media without one.
    if (!media.libraryId && resolvedLib) {
      await this.mediaRepo.update(media.id, {
        library: { id: resolvedLib.id } as Library,
      });
      this.log.log(
        `Import[${history.sourceTitle}]: pinned libraryId=${resolvedLib.id} on media`,
      );
    }

    // libraryRoot = rootPath + folderName (= media.path) — relativePath is
    // stored relative to this because resolveFile joins media.path + relativePath.
    const libraryRoot = path.normalize(path.join(rootPath, folderName));
    const companionExts = await this.fileTransfer.getCompanionExts();

    // For movies or single episode: import the largest file
    // For series with multiple files: import each file as a separate episode
    const isSeasonPack =
      media.type === MediaType.SERIES && videoFiles.length > 1;
    const filesToImport = isSeasonPack
      ? videoFiles
      : [videoFiles.reduce((a, b) => (a.size > b.size ? a : b))];

    if (isSeasonPack) {
      this.log.log(
        `Import[${history.sourceTitle}]: season pack detected — ${filesToImport.length} episodes to import`,
      );
    }

    const importedFiles: {
      savedFile: MediaFile;
      episodeId?: number;
      destPath: string;
    }[] = [];

    for (let idx = 0; idx < filesToImport.length; idx++) {
      const videoFile = filesToImport[idx];
      const ext = path.extname(videoFile.filePath);
      const filename = path.basename(videoFile.filePath, ext);

      let newFilename: string;
      let destDir: string;
      let episodeId: number | undefined;

      if (media.type === MediaType.MOVIE) {
        newFilename = this.naming.applyMovieFormat(movieFormat, {
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          quality: history.quality,
          releaseGroup,
          tmdbId: media.tmdbId,
        });
        destDir = path.join(rootPath, folderName);
      } else {
        // For season packs: parse from individual filename; for single ep: try filename then release name
        const epNums =
          this.naming.parseEpisodeNumbers(filename) ??
          this.naming.parseEpisodeNumbers(history.sourceTitle);

        if (isSeasonPack) {
          this.log.log(
            `Import[${history.sourceTitle}]: [${idx + 1}/${filesToImport.length}] "${filename}" → ${epNums ? `S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')}` : 'no episode parsed'}`,
          );
        }

        let epTitle: string | undefined;
        let airDate: string | undefined;

        if (epNums) {
          const season = await this.seasonRepo.findOne({
            where: { media: { id: media.id }, seasonNumber: epNums.season },
          });
          if (season) {
            const episode = await this.episodeRepo.findOne({
              where: {
                season: { id: season.id },
                episodeNumber: epNums.episode,
              },
            });
            if (episode) {
              epTitle = episode.title ?? undefined;
              airDate = episode.airDate ?? undefined;
              episodeId = episode.id;
              if (
                epNums.episodeEnd != null &&
                episode.endEpisodeNumber !== epNums.episodeEnd
              ) {
                episode.endEpisodeNumber = epNums.episodeEnd;
                await this.episodeRepo.save(episode);
              }
            }
          }
        }

        newFilename = this.naming.applySeriesFormat(seriesFormat, {
          seriesTitle: media.title,
          season: epNums?.season ?? 1,
          episode: epNums?.episode ?? 1,
          episodeTitle: epTitle,
          quality: history.quality,
          releaseGroup,
          airDate,
        });

        const seasonFolder = this.naming.applySeasonFolderFormat(
          seasonFolderFormat,
          { season: epNums?.season ?? 1 },
        );
        destDir = path.join(rootPath, folderName, seasonFolder);
      }

      const destPath = path.join(destDir, newFilename + ext);

      this.log.log(
        `Import[${history.sourceTitle}]: copying "${path.basename(videoFile.filePath)}" → "${destPath}"`,
      );
      await this.fileTransfer.transferFile(
        videoFile.filePath,
        destPath,
        'copy',
      );

      // Copy companion files for this video — torrent client keeps seeding
      // from the source, so we never move.
      const sourceBaseName = path.basename(
        videoFile.filePath,
        path.extname(videoFile.filePath),
      );
      await this.fileTransfer.transferCompanions({
        srcDir: path.dirname(videoFile.filePath),
        destDir,
        sourceBaseName,
        newBaseName: newFilename,
        method: 'copy',
        allowedExts: companionExts,
        logTag: `Import[${history.sourceTitle}]`,
      });

      const relativePath = relativePathUnderMediaRoot(
        path.resolve(libraryRoot),
        path.resolve(destPath),
      );
      if (!relativePath) {
        this.log.error(
          `Import[${history.sourceTitle}]: dest outside library root — resolvedRoot=${path.resolve(libraryRoot)} resolvedDest=${path.resolve(destPath)} libraryRoot=${libraryRoot} dest=${destPath}`,
        );
        continue;
      }
      const streamInfo = await this.ffprobe.detectMediaFileInfo(destPath);

      // Avoid duplicate: update existing record if same path already tracked
      const existingFile = await this.mediaFileRepo.findOne({
        where: { media: { id: media.id }, relativePath },
      });
      const savedFile = existingFile
        ? await this.mediaFileRepo.save(
            Object.assign(existingFile, {
              episode:
                episodeId != null ? ({ id: episodeId } as Episode) : null,
              size: videoFile.size,
              quality: history.quality,
              streamInfo,
            }),
          )
        : await this.mediaFileRepo.save(
            this.mediaFileRepo.create({
              media,
              episode:
                episodeId != null ? ({ id: episodeId } as Episode) : null,
              relativePath,
              size: videoFile.size,
              quality: history.quality,
              streamInfo,
            }),
          );

      if (episodeId != null) {
        await this.episodeRepo.update(episodeId, { hasFile: true });
      }

      importedFiles.push({ savedFile, episodeId, destPath });
    }

    await this.historyRepo.update(history.id, { status: 'completed' });
    this.log.log(
      `Import[${history.sourceTitle}]: completed successfully (${importedFiles.length} file(s))`,
    );

    void this.notifications.dispatch('download.complete', {
      title: media.title,
      quality: history.quality,
      sourceTitle: history.sourceTitle,
    });
    const importRecipients = await this.sseAudience.recipientsForMedia(
      media.id,
    );
    this.events.emitToUsers(importRecipients, {
      type: 'import.complete',
      mediaId: media.id,
      title: media.title,
    });
    this.events.emit({ type: 'queue.updated' });

    void this.mediaServers.dispatch('download.complete', {
      title: media.title,
      path: media.path,
    });

    // Per-file post-import work: cropdetect + embedded-subtitle cache warmup
    // via finalizeImportedFile (shared with disk import / rescan), then the
    // external-subtitle search. Sequential to avoid hammering ffmpeg and the
    // subtitle provider rate limits.
    void (async () => {
      for (const { savedFile, episodeId: epId, destPath } of importedFiles) {
        try {
          await this.mediaService.finalizeImportedFile(
            savedFile,
            destPath,
            media,
          );
        } catch (e) {
          this.log.warn(`Post-import enrichment failed: ${e}`);
        }
        try {
          await this.subtitleScheduler.onMediaFileImported(
            media.id,
            savedFile.id,
            epId,
          );
        } catch (e) {
          this.log.warn(`Post-import subtitle search failed: ${e}`);
        }
      }
    })();

    // Series only: kick off intro / outro marker detection for every
    // season whose episodes just landed. Detection runs at season
    // granularity (it compares audio fingerprints across episodes) so
    // we dedupe per season. Fire-and-forget; the detection itself is
    // queued via a Command row, and the in-flight guard skips seasons
    // already being scanned.
    if (media.type === 'series' && this.autoDetectMarkersOnImport()) {
      void (async () => {
        const seasonIds = new Set<number>();
        for (const { episodeId: epId } of importedFiles) {
          if (epId == null) continue;
          const ep = await this.episodeRepo.findOne({
            where: { id: epId },
            relations: ['season'],
          });
          if (ep?.season?.id) seasonIds.add(ep.season.id);
        }
        for (const seasonId of seasonIds) {
          try {
            await this.markers.detectSeason(seasonId, 'auto');
          } catch (e) {
            // BadRequest (already in flight) and infra errors stay
            // out of the import path — detection is best effort.
            this.log.debug?.(
              `Post-import marker detection skipped season #${seasonId}: ${(e as Error).message}`,
            );
          }
        }
      })();
    }

    // Generate thumbnail sprites (seekbar preview) for each imported file.
    // Runs in background — generateForFile is idempotent and ThumbnailService
    // queues internally to cap concurrency.
    void (async () => {
      for (const { savedFile, episodeId: epId } of importedFiles) {
        let episode: {
          seasonNumber?: number | null;
          episodeNumber?: number | null;
          title?: string | null;
        } | null = null;
        if (epId != null) {
          const ep = await this.episodeRepo.findOne({
            where: { id: epId },
            relations: ['season'],
          });
          if (ep) {
            episode = {
              seasonNumber: ep.season?.seasonNumber,
              episodeNumber: ep.episodeNumber,
              title: ep.title,
            };
          }
        }
        const label = buildSpriteLabel(media, episode);
        try {
          await this.thumbnailService.generateForFile(savedFile, media, label);
        } catch (e) {
          this.log.warn(
            `Post-import sprite generation failed for file #${savedFile.id}: ${e}`,
          );
        }
      }
    })();

    // Execute post-import script if configured
    try {
      const scriptRows: { value: string | null }[] =
        await this.dataSource.query(
          `SELECT value FROM app_settings WHERE key = 'post_import_script' LIMIT 1`,
        );
      const scriptSetting = scriptRows[0];
      const script = scriptSetting?.value?.trim();
      if (script) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const env = {
          ...process.env,
          FLIKS_MEDIA_TITLE: media.title,
          FLIKS_MEDIA_ID: String(media.id),
          FLIKS_MEDIA_TYPE: media.type,
          FLIKS_QUALITY: history.quality,
          FLIKS_FILE_COUNT: String(importedFiles.length),
          FLIKS_SOURCE_TITLE: history.sourceTitle,
        };
        const { stdout, stderr } = await execAsync(script, {
          env,
          timeout: 30_000,
        });
        if (stdout.trim())
          this.log.log(`Post-import script stdout: ${stdout.trim()}`);
        if (stderr.trim())
          this.log.warn(`Post-import script stderr: ${stderr.trim()}`);
      }
    } catch (e) {
      this.log.warn(`Post-import script failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Stalled torrent cleanup
  // ---------------------------------------------------------------------------

  /**
   * Per-library stalled-download cleanup.
   *
   * For every active downloading torrent that can be traced back to a library
   * with a cleanup profile (fast/medium/slow), we snapshot the `downloaded` byte
   * counter at the profile's interval. When the last N snapshots are all equal,
   * the download is considered stalled and is removed + blocklisted.
   *
   * Whether a new search is triggered depends on:
   *   - the profile's `autoRestart` flag,
   *   - the grab source (`auto`|`manual`), and
   *   - the global `cleanup_restart_manual_grabs` setting.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanStalledTorrents(): Promise<void> {
    // Housekeeping first — discard ancient snapshots regardless of anything else.
    await this.pruneOldStalledChecks();

    const profiles = await this.cleanupProfileRepo.find();
    const profileByKey = new Map(profiles.map((p) => [p.key, p]));

    // Skip early if no library has a cleanup profile assigned.
    const allLibraries = await this.libraryRepo.find();
    const librariesWithProfile = allLibraries.filter(
      (l) => l.stalledCleanupProfile != null,
    );
    if (!librariesWithProfile.length) return;
    const libraryById = new Map(librariesWithProfile.map((l) => [l.id, l]));

    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) return;

    const allowManualRestart =
      (await this.settings.get('cleanup_restart_manual_grabs')) === 'true';

    const mediaToResearch = new Set<number>();
    const now = Date.now();

    for (const client of qbitClients) {
      let torrents: QbittorrentTorrent[];
      try {
        torrents = await this.qbittorrent.getTorrents(client);
      } catch {
        continue;
      }

      // Only examine torrents that are still downloading AND not paused by the user.
      // Paused/stopped torrents make no progress by design and should never be flagged.
      const downloading = torrents.filter(
        (t) =>
          t.progress < 1 &&
          t.hash &&
          t.hash.length > 0 &&
          t.state !== 'pausedDL' &&
          t.state !== 'stoppedDL',
      );
      if (!downloading.length) continue;

      // Bulk-load all histories matching these hashes in one query.
      const hashes = downloading.map((t) => t.hash.toLowerCase());
      const histories = await this.historyRepo.find({
        where: { torrentHash: In(hashes) },
      });
      const historyByHash = new Map(
        histories.map((h) => [h.torrentHash.toLowerCase(), h]),
      );

      // Pre-load the media rows we need (to resolve libraryId).
      const mediaIds = Array.from(
        new Set(
          histories
            .map((h) => h.mediaId)
            .filter((id): id is number => id != null),
        ),
      );
      const medias = mediaIds.length
        ? await this.mediaRepo.find({ where: { id: In(mediaIds) } })
        : [];
      const mediaById = new Map(medias.map((m) => [m.id, m]));

      for (const t of downloading) {
        const history = historyByHash.get(t.hash.toLowerCase());
        if (!history) continue; // Untracked torrent — not our business.
        const media = history.mediaId
          ? mediaById.get(history.mediaId)
          : undefined;
        if (!media?.libraryId) continue;
        const library = libraryById.get(media.libraryId);
        if (!library?.stalledCleanupProfile) continue;

        const profile = profileByKey.get(library.stalledCleanupProfile);
        if (!profile) continue;

        const stalled = await this.evaluateStalled(t, profile, now);
        if (!stalled) continue;

        this.log.warn(
          `StalledCleanup: "${t.name}" stalled (profile=${profile.key}, samples=${profile.samples}, interval=${profile.intervalMinutes}m)`,
        );

        // Remove torrent from qBittorrent (files too). If deletion fails we
        // intentionally skip everything else so we don't double-blocklist or
        // mark a history entry failed for a torrent still running in the client.
        try {
          await this.qbittorrent.deleteTorrent(client, t.hash, true);
        } catch (e) {
          this.log.error(
            `StalledCleanup: failed to delete "${t.name}": ${(e as Error).message}`,
          );
          continue;
        }

        await this.stalledCheckRepo.delete({ torrentHash: t.hash });

        const stalledRecipients = await this.sseAudience.recipientsForMedia(
          history.mediaId ?? null,
        );
        this.events.emitToUsers(stalledRecipients, {
          type: 'stalled.removed',
          title: history.sourceTitle ?? t.name,
        });
        this.events.emit({ type: 'queue.updated' });

        await this.blocklist.create({
          sourceTitle: history.sourceTitle ?? t.name,
          quality: history.quality ?? undefined,
          mediaId: history.mediaId ?? undefined,
          indexerId: history.indexerId ?? undefined,
          note: `Auto-blocklist: stalled torrent (profile=${profile.key})`,
        });

        history.status = 'failed';
        history.statusMessage = `Stalled — removed by ${profile.key} cleanup profile`;
        await this.historyRepo.save(history);

        const shouldRestart =
          profile.autoRestart &&
          (history.grabSource === 'auto' || allowManualRestart);
        if (shouldRestart && history.mediaId) {
          mediaToResearch.add(history.mediaId);
          this.log.log(
            `StalledCleanup: "${history.sourceTitle ?? t.name}" blocklisted — auto-restart queued for media #${history.mediaId}`,
          );
        } else if (!shouldRestart) {
          this.log.log(
            `StalledCleanup: "${history.sourceTitle ?? t.name}" blocklisted — no auto-restart (autoRestart=${profile.autoRestart}, grabSource=${history.grabSource})`,
          );
        }
      }
    }

    if (mediaToResearch.size > 0) {
      this.log.log(
        `StalledCleanup: queueing SearchMissing for ${mediaToResearch.size} media(s)`,
      );
      // Insert command directly to avoid circular dep with SchedulerService.
      await this.dataSource.query(
        `INSERT INTO commands (name, status, trigger, body) VALUES ('SearchMissing', 'queued', 'scheduled', $1)`,
        [JSON.stringify({ mediaIds: Array.from(mediaToResearch) })],
      );
    }
  }

  /**
   * Records a snapshot if the interval has elapsed, then checks whether the
   * last `profile.samples` snapshots all have the same `downloadedBytes`.
   */
  private async evaluateStalled(
    torrent: QbittorrentTorrent,
    profile: CleanupProfile,
    now: number,
  ): Promise<boolean> {
    const hash = torrent.hash;
    const currentBytes = BigInt(torrent.downloaded ?? 0).toString();

    const latest = await this.stalledCheckRepo.findOne({
      where: { torrentHash: hash },
      order: { checkedAt: 'DESC' },
    });

    const intervalMs = profile.intervalMinutes * 60_000;
    const shouldSnapshot =
      !latest || now - latest.checkedAt.getTime() >= intervalMs;

    if (shouldSnapshot) {
      await this.stalledCheckRepo.save(
        this.stalledCheckRepo.create({
          torrentHash: hash,
          downloadedBytes: currentBytes,
        }),
      );
    }

    const recent = await this.stalledCheckRepo.find({
      where: { torrentHash: hash },
      order: { checkedAt: 'DESC' },
      take: profile.samples,
    });

    if (recent.length < profile.samples) return false;
    const first = recent[0].downloadedBytes;
    return recent.every((s) => s.downloadedBytes === first);
  }

  /** Deletes stalled-check rows older than 24 h to keep the table small. */
  private async pruneOldStalledChecks(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await this.stalledCheckRepo.delete({ checkedAt: LessThan(cutoff) });
  }

  // ---------------------------------------------------------------------------
  // Seed ratio cleanup — remove torrents that have met their seed ratio target
  // ---------------------------------------------------------------------------

  async cleanSeededTorrents(): Promise<void> {
    // Only care about completed imports that still have a torrent hash
    const completed = await this.historyRepo.find({
      where: { status: 'completed' },
    });
    const withHash = completed.filter((h) => h.torrentHash);
    if (!withHash.length) return;

    // Load all indexers into a map for quick lookup
    const indexers = await this.indexerRepo.find();
    const indexerMap = new Map(indexers.map((ix) => [ix.id, ix]));

    // Fetch torrents from all enabled qBittorrent clients
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) return;

    const allTorrents: {
      client: (typeof clients)[0];
      torrent: QbittorrentTorrent;
    }[] = [];
    for (const client of qbitClients) {
      try {
        const torrents = await this.qbittorrent.getTorrents(client);
        for (const t of torrents) allTorrents.push({ client, torrent: t });
      } catch {
        continue;
      }
    }
    if (!allTorrents.length) return;

    const torrentMap = new Map(
      allTorrents.map((e) => [e.torrent.hash.toLowerCase(), e]),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    let deleted = 0;

    for (const history of withHash) {
      const entry = torrentMap.get(history.torrentHash.toLowerCase());
      if (!entry) continue; // torrent already removed

      const { client, torrent } = entry;
      const indexer = history.indexerId
        ? indexerMap.get(history.indexerId)
        : undefined;
      const settings = indexer?.settings ?? {};
      const targetRatio = Number(settings['seedRatio'] ?? 1);
      const maxRetentionDays =
        settings['maxRetentionDays'] != null
          ? Number(settings['maxRetentionDays'])
          : null;

      let reason = '';
      if (
        maxRetentionDays != null &&
        maxRetentionDays > 0 &&
        torrent.completion_on > 0
      ) {
        const ageDays = (nowSec - torrent.completion_on) / 86400;
        if (ageDays >= maxRetentionDays) {
          reason = `retention ${Math.round(ageDays)}d >= ${maxRetentionDays}d`;
        }
      }
      if (!reason && torrent.ratio >= targetRatio) {
        reason = `ratio ${torrent.ratio.toFixed(2)} >= ${targetRatio}`;
      }

      if (!reason) continue;

      this.log.log(`SeedCleanup: removing "${torrent.name}" (${reason})`);
      try {
        await this.qbittorrent.deleteTorrent(client, torrent.hash, true);
        deleted++;
      } catch (e) {
        this.log.error(
          `SeedCleanup: failed to delete "${torrent.name}": ${(e as Error).message}`,
        );
      }
    }

    if (deleted > 0) {
      this.events.emit({ type: 'queue.updated' });
    }
  }
}
