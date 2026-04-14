import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import {
  QbittorrentService,
  QbittorrentTorrent,
} from '../download-clients/qbittorrent.service';
import { Indexer } from '../indexers/entities/indexer.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NamingService } from './naming.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { EventsService } from './events.service';
import { SettingsService } from '../settings/settings.service';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { MediaServersService } from '../media-servers/media-servers.service';
import { FfprobeService } from '../subtitles/ffprobe.service';
import { MediaType } from '../../common/enums';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { StalledCheck } from './entities/stalled-check.entity';
import { CleanupProfile } from '../cleanup-profiles/entities/cleanup-profile.entity';
import { Library } from '../libraries/entities/library.entity';

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
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
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
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processCompleted(): Promise<void> {
    const grabbed = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'warning' },
      ],
    });
    if (!grabbed.length) return;

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

    const completedTorrents = allTorrents.filter(
      (t) =>
        t.progress >= 1 ||
        t.state === 'seeding' ||
        t.state === 'stalledUP' ||
        t.state === 'stoppedUP',
    );

    // Purge grabbed/failed entries that have no matching torrent in any client
    const allTorrentHashes = new Set(
      allTorrents.map((t) => t.hash?.toLowerCase()),
    );
    const allTorrentNames = new Set(
      allTorrents.map((t) => t.name.toLowerCase()),
    );
    const orphaned = grabbed.filter(
      (h) =>
        !(h.torrentHash && allTorrentHashes.has(h.torrentHash)) &&
        !allTorrentNames.has(h.sourceTitle.toLowerCase()) &&
        !allTorrents.some((t) =>
          t.name.toLowerCase().startsWith(h.sourceTitle.toLowerCase()),
        ),
    );
    if (orphaned.length) {
      await this.historyRepo.remove(orphaned);
      this.log.log(
        `Import: purged ${orphaned.length} orphaned entries (no matching torrent)`,
      );
    }

    const remaining = grabbed.length - orphaned.length;
    if (!remaining || !completedTorrents.length) return;
    this.log.log(
      `Import: ${remaining} entries to process, ${completedTorrents.length} completed torrents`,
    );

    const fmtKeys = [
      'naming_movie_format',
      'naming_movie_folder_format',
      'naming_series_format',
      'naming_series_folder_format',
      'naming_season_folder_format',
    ];
    const fmtRows: { key: string; value: string }[] =
      await this.dataSource.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [fmtKeys],
      );
    const fmtMap = Object.fromEntries(fmtRows.map((r) => [r.key, r.value]));
    const movieFormat =
      fmtMap['naming_movie_format'] ??
      '{Movie Title} ({Release Year}) {Quality Full}';
    const movieFolderFormat =
      fmtMap['naming_movie_folder_format'] ?? '{Movie Title} ({Release Year})';
    const seriesFormat =
      fmtMap['naming_series_format'] ??
      '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';
    const seriesFolderFormat =
      fmtMap['naming_series_folder_format'] ?? '{Series Title}';
    const seasonFolderFormat =
      fmtMap['naming_season_folder_format'] ?? 'Season {season:00}';

    const rootFolders = await this.rootFolderRepo.find({
      order: { path: 'ASC' },
    });

    for (const history of grabbed) {
      const torrent =
        completedTorrents.find(
          (t) =>
            history.torrentHash &&
            t.hash?.toLowerCase() === history.torrentHash,
        ) ??
        completedTorrents.find(
          (t) =>
            t.name.toLowerCase() === history.sourceTitle.toLowerCase() ||
            t.name.toLowerCase().startsWith(history.sourceTitle.toLowerCase()),
        );
      if (!torrent) {
        this.log.debug(
          `Import: no completed torrent matching "${history.sourceTitle}" (mediaId=${history.mediaId})`,
        );
        continue;
      }

      this.log.log(
        `Import: matched "${history.sourceTitle}" → torrent "${torrent.name}" (state=${torrent.state}, progress=${torrent.progress})`,
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
          rootFolders,
        );
      } catch (e) {
        this.log.error(
          `Import: FAILED for "${history.sourceTitle}": ${(e as Error).message}`,
        );
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage: (e as Error).message,
        });

        this.events.emit({
          type: 'import.failed',
          mediaId: history.mediaId,
          title: history.sourceTitle,
          error: (e as Error).message,
        });

        // Auto-blocklist the failed release so it won't be grabbed again
        try {
          await this.blocklist.create({
            sourceTitle: history.sourceTitle,
            quality: history.quality,
            mediaId: history.mediaId,
            note: `Auto-blocklist: import failed — ${(e as Error).message}`,
          });
          this.log.log(`Import: auto-blocklisted "${history.sourceTitle}"`);
        } catch {
          // ignore blocklist errors
        }
      }
    }
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
    rootFolders: RootFolder[],
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

    // Destination root folder
    let rootPath = media.path ?? '';
    if (!rootPath) {
      if (!rootFolders.length) {
        this.log.warn(
          `Import[${history.sourceTitle}]: no root folder configured, skipping`,
        );
        return;
      }
      rootPath = rootFolders[0].path;
      this.log.log(
        `Import[${history.sourceTitle}]: no path on media, using root folder "${rootPath}"`,
      );
    }
    // Resolve rootFolderId for media without one
    const resolvedRf = rootFolders.find((rf) => rootPath.startsWith(rf.path));

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
            year: media.year,
            tmdbId: media.tmdbId,
          }));
    if (!media.folderName) {
      await this.mediaRepo.update(media.id, { folderName });
    }

    // Store rootFolderId if not set
    if (!media.rootFolderId && resolvedRf) {
      await this.mediaRepo.update(media.id, { rootFolder: resolvedRf });
      this.log.log(
        `Import[${history.sourceTitle}]: saved rootFolderId=${resolvedRf.id} on media`,
      );
    }

    const libraryRoot = path.normalize(rootPath);
    const companionExts = await this.getCompanionExts();

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

    const importedFiles: { savedFile: MediaFile; episodeId?: number }[] = [];

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

      await fsp.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, newFilename + ext);

      this.log.log(
        `Import[${history.sourceTitle}]: copying "${path.basename(videoFile.filePath)}" → "${destPath}"`,
      );
      await fsp.copyFile(videoFile.filePath, destPath);

      // Copy companion files for this video
      await this.copyCompanionFiles(
        path.dirname(videoFile.filePath),
        destDir,
        newFilename,
        history.sourceTitle,
        companionExts,
      );

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

      importedFiles.push({ savedFile, episodeId });
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
    this.events.emit({
      type: 'import.complete',
      mediaId: media.id,
      title: media.title,
    });
    this.events.emit({ type: 'queue.updated' });

    void this.mediaServers.dispatch('download.complete', {
      title: media.title,
      path: media.path,
    });

    // Trigger subtitle search for each imported file (sequential to avoid rate limits)
    void (async () => {
      for (const { savedFile, episodeId: epId } of importedFiles) {
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

  private static readonly DEFAULT_COMPANION_EXTS =
    '.nfo,.srt,.ass,.ssa,.sub,.idx,.vtt,.sup,.txt,.jpg,.jpeg,.png,.tbn,.nfo-orig';

  /**
   * Copies whitelisted companion files from srcDir to destDir,
   * renaming them to match the new video filename base.
   */
  private async getCompanionExts(): Promise<Set<string>> {
    const companionRows: { value: string | null }[] =
      await this.dataSource.query(
        `SELECT value FROM app_settings WHERE key = 'companion_file_extensions' LIMIT 1`,
      );
    const row = companionRows[0];
    const raw = row?.value ?? CompletionService.DEFAULT_COMPANION_EXTS;
    return new Set(
      raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`)),
    );
  }

  private async copyCompanionFiles(
    srcDir: string,
    destDir: string,
    newBaseName: string,
    sourceTitle: string,
    allowedExts: Set<string>,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExts.has(ext)) continue;

      // Preserve language suffix if present (e.g. "movie.en.srt" → keep ".en.srt")
      const baseName = path.basename(entry.name, ext);
      const langMatch = baseName.match(/\.([a-z]{2,3}(?:\.[a-z]+)?)$/i);
      const destName = langMatch
        ? `${newBaseName}.${langMatch[1]}${ext}`
        : `${newBaseName}${ext}`;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, destName);
      try {
        await fsp.copyFile(srcPath, destPath);
        this.log.log(
          `Import[${sourceTitle}]: companion "${entry.name}" → "${destName}"`,
        );
      } catch (e) {
        this.log.warn(
          `Import[${sourceTitle}]: failed to copy companion "${entry.name}": ${(e as Error).message}`,
        );
      }
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

        this.events.emit({
          type: 'stalled.removed',
          title: history.sourceTitle ?? t.name,
        });
        this.events.emit({ type: 'queue.updated' });

        await this.blocklist.create({
          sourceTitle: history.sourceTitle ?? t.name,
          quality: history.quality ?? undefined,
          mediaId: history.mediaId ?? undefined,
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
        }
      }
    }

    if (mediaToResearch.size > 0) {
      this.log.log(
        `StalledCleanup: queueing SearchMissing for ${mediaToResearch.size} media(s)`,
      );
      // Insert command directly to avoid circular dep with SchedulerService.
      await this.dataSource.query(
        `INSERT INTO commands (name, status, trigger, body) VALUES ('SearchMissing', 'queued', 'scheduled', '{}')`,
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
