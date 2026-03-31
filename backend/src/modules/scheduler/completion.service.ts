import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
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
import { NotificationsService } from '../notifications/notifications.service';
import { NamingService } from './naming.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { RemotePathMapping } from '../settings/entities/remote-path-mapping.entity';

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
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processCompleted(): Promise<void> {
    const mappings = await this.pathMappingRepo.find();

    const grabbed = await this.historyRepo.find({
      where: [{ status: 'grabbed' }, { status: 'failed' }],
    });
    if (!grabbed.length) return;
    this.log.log(
      `Import: ${grabbed.length} entries to process (grabbed + failed)`,
    );

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
    this.log.log(
      `Import: ${allTorrents.length} torrents from ${qbitClients.length} client(s)`,
    );

    const completedTorrents = allTorrents.filter(
      (t) =>
        t.progress >= 1 || t.state === 'seeding' || t.state === 'stalledUP',
    );
    this.log.log(`Import: ${completedTorrents.length} completed torrents`);
    if (!completedTorrents.length) return;

    const fmtKeys = [
      'naming_movie_format',
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
      const torrent = completedTorrents.find(
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
        await this.historyRepo.update(history.id, { status: 'failed' });

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

    let videoFile = this.naming.findLargestVideoFile(searchDir);

    // Fallback: single-file torrent sitting directly at save_path
    if (!videoFile) {
      for (const ext of ['.mkv', '.mp4', '.avi', '.mov', '.ts']) {
        const candidate = path.join(translatedSavePath, torrent.name + ext);
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          videoFile = { filePath: candidate, size: stat.size };
          break;
        }
      }
    }

    if (!videoFile) {
      this.log.warn(
        `Import[${history.sourceTitle}]: no video file found in "${searchDir}"`,
      );
      return;
    }
    this.log.log(
      `Import[${history.sourceTitle}]: found video "${videoFile.filePath}" (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)`,
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

    const ext = path.extname(videoFile.filePath);
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
    } else {
      this.log.log(
        `Import[${history.sourceTitle}]: using media path "${rootPath}"`,
      );
    }

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
      const safeTitle = media.title.replace(/[<>:"/\\|?*]/g, '').trim();
      destDir = path.join(
        rootPath,
        media.year ? `${safeTitle} (${media.year})` : safeTitle,
      );
    } else {
      const epNums = this.naming.parseEpisodeNumbers(history.sourceTitle);
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

      // Build series/season subfolder structure
      const seriesFolder = this.naming.applySeriesFolderFormat(
        seriesFolderFormat,
        {
          seriesTitle: media.title,
          year: media.year,
          tmdbId: media.tmdbId,
        },
      );
      const seasonFolder = this.naming.applySeasonFolderFormat(
        seasonFolderFormat,
        {
          season: epNums?.season ?? 1,
        },
      );
      destDir = path.join(rootPath, seriesFolder, seasonFolder);
    }

    this.log.log(
      `Import[${history.sourceTitle}]: destDir="${destDir}", filename="${newFilename}${ext}"`,
    );

    fs.mkdirSync(destDir, { recursive: true });

    const destPath = path.join(destDir, newFilename + ext);

    this.log.log(
      `Import[${history.sourceTitle}]: copying "${videoFile.filePath}" → "${destPath}"`,
    );
    fs.copyFileSync(videoFile.filePath, destPath);
    this.log.log(`Import[${history.sourceTitle}]: copy OK`);

    // Store media path if it was not set (root folder path for the media)
    if (!media.path) {
      await this.mediaRepo.update(media.id, { path: rootPath });
      this.log.log(
        `Import[${history.sourceTitle}]: saved root path "${rootPath}" on media`,
      );
    }

    const relativePath = path.relative(destDir, destPath);
    await this.mediaFileRepo.save(
      this.mediaFileRepo.create({
        mediaId: media.id,
        episodeId,
        relativePath,
        size: videoFile.size,
        quality: history.quality,
      }),
    );

    await this.historyRepo.update(history.id, { status: 'completed' });
    this.log.log(`Import[${history.sourceTitle}]: completed successfully`);

    void this.notifications.dispatch('download.complete', {
      title: media.title,
      quality: history.quality,
      sourceTitle: history.sourceTitle,
    });

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
          SUITARR_FILE_PATH: destPath,
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
}
