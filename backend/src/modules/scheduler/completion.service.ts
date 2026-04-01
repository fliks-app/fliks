import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseReleaseQuality } from '../media/release-quality.parser';
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
import { NotificationsService } from '../notifications/notifications.service';
import { NamingService } from './naming.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { RemotePathMapping } from '../settings/entities/remote-path-mapping.entity';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';

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
    private readonly qbittorrent: QbittorrentService,
    private readonly notifications: NotificationsService,
    private readonly naming: NamingService,
    private readonly blocklist: BlocklistService,
    @InjectRepository(RemotePathMapping)
    private readonly pathMappingRepo: Repository<RemotePathMapping>,
    private readonly subtitleScheduler: SubtitleSchedulerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processCompleted(): Promise<void> {
    const mappings = await this.pathMappingRepo.find();

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
          return torrents.map((t) => ({ ...t, _clientId: c.id }));
        }),
      )
    ).flat();

    const completedTorrents = allTorrents.filter(
      (t) =>
        t.progress >= 1 || t.state === 'seeding' || t.state === 'stalledUP',
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
          mappings,
        );
      } catch (e) {
        this.log.error(
          `Import: FAILED for "${history.sourceTitle}": ${(e as Error).message}`,
        );
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage: (e as Error).message,
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

  private translatePath(
    savePath: string,
    clientId: number | undefined,
    mappings: RemotePathMapping[],
  ): string {
    for (const m of mappings) {
      if (m.downloadClientId && m.downloadClientId !== clientId) continue;
      if (savePath.startsWith(m.remotePath)) {
        return m.localPath + savePath.slice(m.remotePath.length);
      }
    }
    return savePath;
  }

  private async processOne(
    history: DownloadHistory,
    torrent: QbittorrentTorrent & { _clientId?: number },
    movieFormat: string,
    movieFolderFormat: string,
    seriesFormat: string,
    seriesFolderFormat: string,
    seasonFolderFormat: string,
    rootFolders: RootFolder[],
    mappings: RemotePathMapping[],
  ): Promise<void> {
    // Apply remote path mapping
    const translatedSavePath = this.translatePath(
      torrent.save_path,
      torrent._clientId,
      mappings,
    );

    // Locate video file — torrent may be a folder or a single file
    const saveDir = path.join(translatedSavePath, torrent.name);
    const isDirTorrent =
      fs.existsSync(saveDir) && fs.statSync(saveDir).isDirectory();
    const searchDir = isDirTorrent ? saveDir : translatedSavePath;
    this.log.log(
      `Import[${history.sourceTitle}]: searching for video in "${searchDir}" (isDir=${isDirTorrent})`,
    );

    // Find all video files in the torrent
    let videoFiles = this.naming.findAllVideoFiles(searchDir);

    // Fallback: single-file torrent sitting directly at save_path
    if (!videoFiles.length) {
      for (const ext of ['.mkv', '.mp4', '.avi', '.mov', '.ts']) {
        const candidate = path.join(translatedSavePath, torrent.name + ext);
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          videoFiles = [{ filePath: candidate, size: stat.size }];
          break;
        }
      }
    }

    if (!videoFiles.length) {
      const largestAny = this.findLargestFile(searchDir);
      if (largestAny) {
        const suspectExt =
          path.extname(largestAny.filePath).toLowerCase() || '(no extension)';
        const suspectFile = path.basename(largestAny.filePath);
        const sizeMb = (largestAny.size / 1024 / 1024).toFixed(1);
        const statusMessage =
          `Import blocked: no valid video file found. ` +
          `Largest file: "${suspectFile}" (${sizeMb} MB), extension: "${suspectExt}". ` +
          `Allowed: .mkv, .mp4, .avi, .mov, .ts, .m2ts, .wmv, .flv`;
        this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage,
        });
        try {
          await this.blocklist.create({
            sourceTitle: history.sourceTitle,
            quality: history.quality,
            mediaId: history.mediaId,
            note: `Blocked: no valid video file — largest file has extension "${suspectExt}"`,
          });
        } catch {
          /* ignore */
        }
      } else {
        const statusMessage = `Import blocked: no files found in "${searchDir}"`;
        this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage,
        });
      }
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

    // Quality gate (checked once for the whole import)
    const newParsed = parseReleaseQuality(history.sourceTitle);
    const newRank = newParsed.quality.rank;

    const existingFiles = await this.mediaFileRepo.find({
      where: { mediaId: media.id },
    });
    if (existingFiles.length > 0) {
      const bestExisting = Math.max(
        ...existingFiles.map(
          (f) => parseReleaseQuality(f.quality).quality.rank,
        ),
      );
      if (newRank < bestExisting) {
        const bestLabel = existingFiles
          .map((f) => ({
            f,
            rank: parseReleaseQuality(f.quality).quality.rank,
          }))
          .sort((a, b) => b.rank - a.rank)[0].f.quality;
        const msg =
          `Quality not upgraded: existing "${bestLabel}" (rank ${bestExisting}) ` +
          `> new "${newParsed.label}" (rank ${newRank})`;
        this.log.warn(`Import[${history.sourceTitle}]: ${msg}`);
        await this.historyRepo.update(history.id, {
          status: 'warning',
          statusMessage: msg,
        });
        return;
      }
    }

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

    // Ensure folderName is set
    const folderName =
      media.folderName ||
      (media.type === 'movie'
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

    // Store media path if not set
    if (!media.path) {
      await this.mediaRepo.update(media.id, { path: rootPath });
      this.log.log(
        `Import[${history.sourceTitle}]: saved root path "${rootPath}" on media`,
      );
    }

    const libraryRoot = path.normalize(rootPath);
    const companionExts = await this.getCompanionExts();

    // For movies or single episode: import the largest file
    // For series with multiple files: import each file as a separate episode
    const isSeasonPack = media.type === 'series' && videoFiles.length > 1;
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

      if (media.type === 'movie') {
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
            where: { mediaId: media.id, seasonNumber: epNums.season },
          });
          if (season) {
            const episode = await this.episodeRepo.findOne({
              where: { seasonId: season.id, episodeNumber: epNums.episode },
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

      const relativePath = path.relative(libraryRoot, path.normalize(destPath));
      const savedFile = await this.mediaFileRepo.save(
        this.mediaFileRepo.create({
          mediaId: media.id,
          episodeId,
          relativePath,
          size: videoFile.size,
          quality: history.quality,
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
      const [scriptSetting] = await this.dataSource.query(
        `SELECT value FROM app_settings WHERE key = 'post_import_script' LIMIT 1`,
      );
      const script = scriptSetting?.value?.trim();
      if (script) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const env = {
          ...process.env,
          SUITARR_MEDIA_TITLE: media.title,
          SUITARR_MEDIA_ID: String(media.id),
          SUITARR_MEDIA_TYPE: media.type,
          SUITARR_QUALITY: history.quality,
          SUITARR_FILE_COUNT: String(importedFiles.length),
          SUITARR_SOURCE_TITLE: history.sourceTitle,
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

  /** Find the largest file in a directory (any extension) for suspicious content detection. */
  private findLargestFile(
    dirPath: string,
  ): { filePath: string; size: number } | null {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      let best: { filePath: string; size: number } | null = null;
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const sub = this.findLargestFile(fullPath);
          if (sub && (!best || sub.size > best.size)) best = sub;
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (!best || stat.size > best.size) {
            best = { filePath: fullPath, size: stat.size };
          }
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  private static readonly DEFAULT_COMPANION_EXTS =
    '.nfo,.srt,.ass,.ssa,.sub,.idx,.vtt,.sup,.txt,.jpg,.jpeg,.png,.tbn,.nfo-orig';

  /**
   * Copies whitelisted companion files from srcDir to destDir,
   * renaming them to match the new video filename base.
   */
  private async getCompanionExts(): Promise<Set<string>> {
    const [row] = await this.dataSource.query(
      `SELECT value FROM app_settings WHERE key = 'companion_file_extensions' LIMIT 1`,
    );
    const raw = row?.value ?? CompletionService.DEFAULT_COMPANION_EXTS;
    return new Set(
      (raw as string)
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
}
