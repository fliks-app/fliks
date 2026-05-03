import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { existsSync } from 'fs';
import { In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronExpressionParser } from 'cron-parser';
import { Command } from './entities/command.entity';
import { Media } from '../media/entities/media.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { MediaService } from '../media/media.service';
import { MediaType, MinimumAvailability } from '../../common/enums';
import { ConfigService } from '@nestjs/config';
import { CompletionService } from './completion.service';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { NamingService } from './naming.service';
import { DelayProfile } from '../profiles/entities/delay-profile.entity';
import { EventsService } from './events.service';
import { MediaFile } from '../media/entities/media-file.entity';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../streaming/thumbnail.service';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { MarkersService } from '../markers/markers.service';
import {
  buildAllowedQualityIds,
  buildIndexerMinSeeders,
  allowedAudioLanguageIds,
  scoreAndSortReleases,
} from '../media/release-rejection.helper';

/** Yield the event loop so HTTP requests aren't starved by bulk tasks. */
const yieldLoop = () => new Promise<void>((r) => setTimeout(r, 50));

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly log = new Logger(SchedulerService.name);

  constructor(
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    private readonly torznab: TorznabService,
    private readonly qbittorrent: QbittorrentService,
    private readonly tmdb: TmdbProvider,
    private readonly mediaService: MediaService,
    private readonly config: ConfigService,
    private readonly completion: CompletionService,
    private readonly naming: NamingService,
    @InjectRepository(DelayProfile)
    private readonly delayProfileRepo: Repository<DelayProfile>,
    private readonly eventsService: EventsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly thumbnailService: ThumbnailService,
    private readonly customFormats: CustomFormatsService,
    private readonly qualityDefs: QualityDefinitionsService,
    private readonly blocklist: BlocklistService,
    private readonly markers: MarkersService,
  ) {}

  // ---------------------------------------------------------------------------
  // Scheduler definitions
  // ---------------------------------------------------------------------------

  private static readonly SCHEDULERS: {
    name: string;
    cron: string;
    triggerable: boolean;
  }[] = [
    {
      name: 'SearchMissing',
      cron: CronExpression.EVERY_6_HOURS,
      triggerable: true,
    },
    {
      name: 'RefreshMetadata',
      cron: CronExpression.EVERY_DAY_AT_4AM,
      triggerable: true,
    },
    {
      name: 'RssSync',
      cron: '*/15 * * * *',
      triggerable: true,
    },
    {
      name: 'ImportCompleted',
      cron: CronExpression.EVERY_MINUTE,
      triggerable: true,
    },
    {
      name: 'CleanStalled',
      cron: CronExpression.EVERY_5_MINUTES,
      triggerable: true,
    },
    {
      name: 'CleanSeeded',
      cron: CronExpression.EVERY_MINUTE,
      triggerable: true,
    },
    {
      name: 'SubtitleSearch',
      cron: CronExpression.EVERY_6_HOURS,
      triggerable: true,
    },
    {
      name: 'SubtitleUpgrade',
      cron: CronExpression.EVERY_6_HOURS,
      triggerable: true,
    },
  ];

  async onModuleInit() {
    const stale = await this.commandRepo.update(
      { status: In(['running', 'queued']) },
      { status: 'failed', endedOn: new Date() },
    );
    if (stale.affected) {
      this.log.warn(
        `Marked ${stale.affected} stale command(s) as failed on startup`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduled jobs
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_6_HOURS)
  async searchMissing(): Promise<void> {
    return this.runCommand('SearchMissing', 'scheduled', () =>
      this.doSearchMissing(),
    );
  }

  /** Refresh metadata for all media once a day */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshMetadata(): Promise<void> {
    return this.runCommand('RefreshMetadata', 'scheduled', () =>
      this.doRefreshMetadata(),
    );
  }

  /** RSS sync every 15 minutes */
  @Cron('*/15 * * * *')
  async rssSync(): Promise<void> {
    return this.runCommand('RssSync', 'scheduled', () => this.doRssSync());
  }

  // ---------------------------------------------------------------------------
  // Manual trigger
  // ---------------------------------------------------------------------------

  async getSchedulers(): Promise<
    {
      name: string;
      cron: string;
      triggerable: boolean;
      lastRun: Date | null;
      lastStatus: string | null;
      nextRun: Date;
    }[]
  > {
    const names = SchedulerService.SCHEDULERS.map((s) => s.name);

    // Get last command per scheduler name in one query
    const lastCommands = await this.commandRepo
      .createQueryBuilder('c')
      .where('c.name IN (:...names)', { names })
      .andWhere(
        'c.id = (SELECT c2.id FROM commands c2 WHERE c2.name = c.name ORDER BY c2."createdAt" DESC LIMIT 1)',
      )
      .getMany();

    const lastByName = new Map(lastCommands.map((c) => [c.name, c]));

    return SchedulerService.SCHEDULERS.map((s) => {
      const last = lastByName.get(s.name);
      const interval = CronExpressionParser.parse(s.cron);
      return {
        name: s.name,
        cron: s.cron,
        triggerable: s.triggerable,
        lastRun: last?.startedOn ?? null,
        lastStatus: last?.status ?? null,
        nextRun: interval.next().toDate(),
      };
    });
  }

  async triggerCommand(name: string): Promise<Command> {
    const known = [
      ...SchedulerService.SCHEDULERS.filter((s) => s.triggerable).map(
        (s) => s.name,
      ),
      'RescanAll',
      'RefreshMissingMetadata',
      'RescanMissingFiles',
      'GenerateSprites',
      'GenerateMissingSprites',
      'DetectMarkers',
      'DetectMissingMarkers',
    ];
    if (!known.includes(name)) {
      throw new Error(`Unknown command: ${name}. Valid: ${known.join(', ')}`);
    }

    const cmd = await this.commandRepo.save(
      this.commandRepo.create({ name, status: 'queued', trigger: 'manual' }),
    );

    // Fire-and-forget, do not await
    this.dispatchCommand(name, cmd.id).catch((e) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      this.log.error(`Command ${name} failed: ${e.message}`),
    );

    return cmd;
  }

  async getRecentCommands(
    page = 1,
    limit = 25,
  ): Promise<{ data: Command[]; total: number }> {
    const [data, total] = await this.commandRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  /**
   * Delete every command row except those still running or queued. Used by
   * the admin "clear history" button.
   */
  async clearCommandHistory(): Promise<{ deleted: number }> {
    const result = await this.commandRepo
      .createQueryBuilder()
      .delete()
      .where('status NOT IN (:...keep)', { keep: ['running', 'queued'] })
      .execute();
    this.log.log(
      `Command history cleared — ${result.affected ?? 0} row(s) deleted`,
    );
    return { deleted: result.affected ?? 0 };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runCommand(
    name: string,
    trigger: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const cmd = await this.commandRepo.save(
      this.commandRepo.create({
        name,
        status: 'running',
        trigger,
        startedOn: new Date(),
      }),
    );
    this.eventsService.emit({ type: 'command.started', name });
    try {
      await fn();
      cmd.status = 'completed';
    } catch (e) {
      this.log.error(`Command ${name} error: ${(e as Error).message}`);
      cmd.status = 'failed';
    } finally {
      cmd.endedOn = new Date();
      await this.commandRepo.save(cmd);
      this.eventsService.emit({
        type: 'command.completed',
        name,
        status: cmd.status,
      });
    }
  }

  private async dispatchCommand(name: string, cmdId: number): Promise<void> {
    await this.commandRepo.update(cmdId, {
      status: 'running',
      startedOn: new Date(),
    });
    this.eventsService.emit({ type: 'command.started', name });
    try {
      if (name === 'SearchMissing') await this.doSearchMissing();
      else if (name === 'RefreshMetadata') await this.doRefreshMetadata();
      else if (name === 'RssSync') await this.doRssSync();
      else if (name === 'ImportCompleted')
        await this.completion.processCompleted();
      else if (name === 'CleanStalled')
        await this.completion.cleanStalledTorrents();
      else if (name === 'CleanSeeded')
        await this.completion.cleanSeededTorrents();
      else if (name === 'SubtitleSearch')
        await this.subtitleScheduler.searchMissingSubtitles();
      else if (name === 'SubtitleUpgrade')
        await this.subtitleScheduler.upgradeSubtitles();
      else if (name === 'RescanAll') await this.doRescanAll();
      else if (name === 'RefreshMissingMetadata')
        await this.doRefreshMissingMetadata();
      else if (name === 'RescanMissingFiles') await this.doRescanMissingFiles();
      else if (name === 'GenerateSprites') await this.doGenerateSprites(true);
      else if (name === 'GenerateMissingSprites')
        await this.doGenerateSprites(false);
      else if (name === 'DetectMarkers') await this.doDetectMarkers(false);
      else if (name === 'DetectMissingMarkers')
        await this.doDetectMarkers(true);
      await this.commandRepo.update(cmdId, {
        status: 'completed',
        endedOn: new Date(),
      });
      this.eventsService.emit({
        type: 'command.completed',
        name,
        status: 'completed',
      });
    } catch (e) {
      await this.commandRepo.update(cmdId, {
        status: 'failed',
        endedOn: new Date(),
      });
      this.eventsService.emit({
        type: 'command.completed',
        name,
        status: 'failed',
      });
      throw e;
    }
  }

  private async doSearchMissing(): Promise<void> {
    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC' },
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));

    if (!indexers.length) {
      throw new Error('No enabled indexers configured');
    }
    if (!qbitClient) {
      throw new Error('No enabled download client configured');
    }

    const connCheck = await this.qbittorrent.testConnection(
      qbitClient.settings,
    );
    if (!connCheck.ok) {
      throw new Error(`Download client unreachable — ${connCheck.message}`);
    }

    await this.searchMissingMovies(indexers, qbitClient);
    await this.searchMissingEpisodes(indexers, qbitClient);
  }

  private async searchMissingMovies(
    indexers: Indexer[],
    qbitClient: DownloadClient,
  ): Promise<void> {
    const missing = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoin('m.files', 'f')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('f.id IS NULL')
      .getMany();

    if (!missing.length) return;

    const today = new Date().toISOString().slice(0, 10);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);
    const indexerUnknownLang = new Map(
      indexers.map((ix) => [
        ix.id,
        ix.settings?.unknownLanguageIsoCode as string | undefined,
      ]),
    );

    for (let i = 0; i < missing.length; i++) {
      const media = missing[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: missing.length,
        message: media.title,
      });

      if (!this.isAvailable(media, today)) continue;

      const pending = await this.historyRepo.findOne({
        where: { media: { id: media.id }, status: 'grabbed' },
      });
      if (pending) continue;

      const query = [media.title, media.year].filter(Boolean).join(' ');
      const batches = await Promise.allSettled(
        indexers.map((ix) => this.torznab.searchMovie(ix, query)),
      );
      const results = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );
      if (!results.length) continue;

      const sorted = await scoreAndSortReleases(
        results,
        {
          allowed: buildAllowedQualityIds(media.qualityProfile?.items),
          allowedLangs: allowedAudioLanguageIds(
            media.languageProfile?.audioLanguages,
          ),
          sizeByQuality,
          indexerMinSeeders,
          indexerUnknownLang,
          runtimeMinutes: media.runtime ?? 0,
        },
        this.scorerDeps(),
      );
      const pick = sorted.find((r) => r.rejections.length === 0);
      if (!pick) {
        this.log.debug?.(
          `SearchMissing[movie]: no release without rejections for "${media.title}" (${sorted.length} checked)`,
        );
        continue;
      }

      try {
        this.log.log(
          `SearchMissing: sending movie "${pick.title}" to qBittorrent — ${pick.downloadUrl}`,
        );
        await this.qbittorrent.addTorrentUrl(
          qbitClient,
          pick.downloadUrl,
          'movie',
        );
        await this.historyRepo.save(
          this.historyRepo.create({
            media,
            downloadClient: qbitClient,
            indexer: { id: pick.indexerId } as Indexer,
            sourceTitle: pick.title,
            quality: this.naming.parseQuality(pick.title),
            status: 'grabbed',
          }),
        );
        this.log.log(
          `SearchMissing[movie]: grabbed "${pick.title}" for "${media.title}"`,
        );
      } catch (e) {
        this.log.warn(
          `SearchMissing[movie]: grab failed for "${media.title}": ${(e as Error).message}`,
        );
      }
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: missing.length,
      total: missing.length,
      message: 'SearchMissing',
    });
  }

  private async searchMissingEpisodes(
    indexers: Indexer[],
    qbitClient: DownloadClient,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);
    const indexerUnknownLang = new Map(
      indexers.map((ix) => [
        ix.id,
        ix.settings?.unknownLanguageIsoCode as string | undefined,
      ]),
    );

    // Find monitored series with monitored, un-downloaded, aired episodes.
    // Include quality + language profiles for scoring.
    const episodes = await this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .innerJoin('season.media', 'media')
      .leftJoinAndSelect('media.qualityProfile', 'qp')
      .leftJoinAndSelect('media.languageProfile', 'lp')
      .where('media.monitored = true')
      .andWhere('media.type = :type', { type: MediaType.SERIES })
      .andWhere('season.monitored = true')
      .andWhere('ep.monitored = true')
      .andWhere('ep.hasFile = false')
      .andWhere('ep.airDate IS NOT NULL')
      .andWhere('ep.airDate <= :today', { today })
      .select(['ep.id', 'ep.episodeNumber', 'ep.title', 'ep.airDate'])
      .addSelect(['season.id', 'season.seasonNumber', 'season.mediaId'])
      .addSelect(['media.id', 'media.title', 'media.year', 'media.runtime'])
      .getMany();

    if (!episodes.length) return;

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const season = (ep as any).season as Season;
      const media = (season as any).media as Media;
      const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;

      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: episodes.length,
        message: `${media.title} ${epLabel}`,
      });

      const pending = await this.historyRepo
        .createQueryBuilder('h')
        .where('h.mediaId = :mediaId', { mediaId: media.id })
        .andWhere('h.status = :status', { status: 'grabbed' })
        .andWhere(`h.sourceTitle ILIKE :pattern`, {
          pattern: `%S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}%`,
        })
        .getOne();
      if (pending) continue;

      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeries(
            ix,
            media.title,
            season.seasonNumber,
            ep.episodeNumber,
          ),
        ),
      );
      const results = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );
      if (!results.length) continue;

      const sorted = await scoreAndSortReleases(
        results,
        {
          allowed: buildAllowedQualityIds(media.qualityProfile?.items),
          allowedLangs: allowedAudioLanguageIds(
            media.languageProfile?.audioLanguages,
          ),
          sizeByQuality,
          indexerMinSeeders,
          indexerUnknownLang,
          // Episodes are typically 20-60 min; use 30 min as fallback for size check.
          runtimeMinutes: media.runtime ?? 30,
        },
        this.scorerDeps(),
      );
      const pick = sorted.find((r) => r.rejections.length === 0);
      if (!pick) {
        this.log.debug?.(
          `SearchMissing[series]: no release without rejections for "${media.title}" ${epLabel} (${sorted.length} checked)`,
        );
        continue;
      }

      try {
        this.log.log(
          `SearchMissing: sending episode "${pick.title}" to qBittorrent — ${pick.downloadUrl}`,
        );
        await this.qbittorrent.addTorrentUrl(
          qbitClient,
          pick.downloadUrl,
          'series',
        );
        await this.historyRepo.save(
          this.historyRepo.create({
            media,
            downloadClient: qbitClient,
            indexer: { id: pick.indexerId } as Indexer,
            sourceTitle: pick.title,
            quality: this.naming.parseQuality(pick.title),
            status: 'grabbed',
          }),
        );
        this.log.log(
          `SearchMissing[series]: grabbed "${pick.title}" for "${media.title}" ${epLabel}`,
        );
      } catch (e) {
        this.log.warn(
          `SearchMissing[series]: grab failed for "${media.title}" ep ${ep.id}: ${(e as Error).message}`,
        );
      }
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: episodes.length,
      total: episodes.length,
      message: 'SearchMissing',
    });
  }

  private async doRefreshMetadata(): Promise<void> {
    const apiKey = this.config.get<string>('TMDB_API_KEY', '');
    if (!apiKey?.trim()) {
      this.log.warn('RefreshMetadata: TMDB_API_KEY not configured');
      return;
    }

    const allMedia = await this.mediaRepo.find();
    this.log.log(
      `RefreshMetadata: starting refresh for ${allMedia.length} media`,
    );
    let updated = 0;

    for (let i = 0; i < allMedia.length; i++) {
      const media = allMedia[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMetadata',
        current: i,
        total: allMedia.length,
        message: media.title,
      });
      this.log.log(
        `RefreshMetadata: refreshing "${media.title}" (${i + 1}/${allMedia.length})`,
      );
      try {
        await this.mediaService.refreshMetadata(media.id);
        updated++;
      } catch (e) {
        this.log.warn(
          `RefreshMetadata: failed for "${media.title}": ${(e as Error).message}`,
        );
      }
      await yieldLoop();
    }

    if (allMedia.length > 0) {
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMetadata',
        current: allMedia.length,
        total: allMedia.length,
        message: 'RefreshMetadata',
      });
    }

    this.log.log(
      `RefreshMetadata: updated ${updated}/${allMedia.length} titles`,
    );
  }

  private async doGenerateSprites(force: boolean): Promise<void> {
    const commandName = force ? 'GenerateSprites' : 'GenerateMissingSprites';
    const BATCH = 2;
    // Only load IDs — avoid pulling full streamInfo/media into memory.
    const allIds: { id: number }[] = await this.mediaFileRepo.find({
      select: ['id'],
    });
    // Pre-filter: skip files that already have a sprite on disk (fast existsSync).
    // Only when not forcing regeneration.
    const fileIds = force
      ? allIds
      : allIds.filter(({ id }) => !existsSync(this.thumbnailService.getMetadataPath(id)));
    this.log.log(
      `${commandName}: ${fileIds.length} to generate (${allIds.length - fileIds.length} already exist, ${allIds.length} total)`,
    );

    let generated = 0;
    // Process in batches of BATCH — each file is queued into ThumbnailService
    // which limits FFmpeg concurrency internally (SPRITE_CONCURRENCY).
    for (let i = 0; i < fileIds.length; i += BATCH) {
      const batch = fileIds.slice(i, i + BATCH);
      this.eventsService.emit({
        type: 'task.progress',
        command: commandName,
        current: i,
        total: fileIds.length,
        message: commandName,
      });

      const promises = batch.map(async ({ id }) => {
        try {
          const file = await this.mediaFileRepo.findOne({
            where: { id },
            relations: ['media'],
          });
          if (!file?.media) return null;

          let label = file.media.title;
          if (file.episodeId) {
            const ep = await this.episodeRepo.findOne({
              where: { id: file.episodeId },
              relations: ['season'],
            });
            if (ep) {
              label = buildSpriteLabel(
                { title: ep.title ?? '' },
                {
                  seasonNumber: ep.season.seasonNumber,
                  episodeNumber: ep.episodeNumber,
                  title: ep.title,
                },
              );
            }
          }

          return this.thumbnailService.generateForFile(
            file, file.media, label, { force, skipTracking: true },
          );
        } catch (e) {
          this.log.warn(
            `${commandName}: failed for file ${id}: ${(e as Error).message}`,
          );
          return null;
        }
      });

      const results = await Promise.all(promises);
      generated += results.filter((r) => r != null).length;
      await yieldLoop();
    }

    this.log.log(
      `${commandName}: generated ${generated}/${fileIds.length} sprites`,
    );
  }

  private async doRssSync(): Promise<void> {
    const indexers = await this.indexerRepo.find({
      where: { enabled: true, enableRss: true },
      order: { priority: 'ASC' },
    });

    if (!indexers.length) return;

    // Collect monitored movie titles for matching
    const monitored = await this.mediaRepo.find({
      where: { monitored: true, type: MediaType.MOVIE },
      select: ['id', 'title', 'year'],
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbitClient) {
      throw new Error('No enabled download client configured');
    }

    const connCheck = await this.qbittorrent.testConnection(
      qbitClient.settings,
    );
    if (!connCheck.ok) {
      throw new Error(`Download client unreachable — ${connCheck.message}`);
    }

    const delayProfiles = await this.delayProfileRepo.find({
      order: { order: 'ASC' },
    });

    for (let i = 0; i < indexers.length; i++) {
      const indexer = indexers[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RssSync',
        current: i,
        total: indexers.length,
        message: indexer.name,
      });
      try {
        const results = await this.torznab.rssSearch(indexer);
        for (const release of results) {
          const match = monitored.find((m) =>
            release.title.toLowerCase().includes(m.title.toLowerCase()),
          );
          if (!match) continue;

          // Check delay profile
          if (
            release.publishDate &&
            this.isDelayed(match, release.publishDate, delayProfiles)
          )
            continue;

          // Check if already in history
          const alreadyGrabbed = await this.historyRepo.findOne({
            where: { media: { id: match.id }, sourceTitle: release.title },
          });
          if (alreadyGrabbed) continue;

          try {
            this.log.log(
              `RSS: sending "${release.title}" to qBittorrent — ${release.downloadUrl}`,
            );
            await this.qbittorrent.addTorrentUrl(
              qbitClient,
              release.downloadUrl,
              'movie',
            );
            await this.historyRepo.save(
              this.historyRepo.create({
                media: match,
                downloadClient: qbitClient,
                indexer: { id: release.indexerId } as Indexer,
                sourceTitle: release.title,
                quality: this.naming.parseQuality(release.title),
                status: 'grabbed',
              }),
            );
            this.log.log(
              `RssSync: grabbed "${release.title}" for "${match.title}"`,
            );
          } catch {
            // ignore individual grab errors
          }
        }
      } catch (e) {
        this.log.warn(
          `RssSync: indexer "${indexer.name}" failed: ${(e as Error).message}`,
        );
      }
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'RssSync',
      current: indexers.length,
      total: indexers.length,
      message: 'RssSync',
    });
  }

  /**
   * Bulk intro + outro detection across every series. When `onlyMissing` is
   * true, only scans seasons that still have at least one episode lacking
   * an intro or outro marker.
   */
  private async doDetectMarkers(onlyMissing: boolean): Promise<void> {
    const name = onlyMissing ? 'DetectMissingMarkers' : 'DetectMarkers';
    const seasons = await this.markers.listSeasonsForScan(onlyMissing);
    this.log.log(`${name}: started — ${seasons.length} season(s) to scan`);
    let detected = 0;
    let skipped = 0;
    for (let i = 0; i < seasons.length; i++) {
      const s = seasons[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: name,
        current: i,
        total: seasons.length,
        message: `${s.mediaTitle} S${String(s.seasonNumber).padStart(2, '0')}`,
      });
      try {
        const r = await this.markers.runDetectionInline(s.id);
        detected += r.introsDetected + r.outrosDetected;
      } catch (e) {
        skipped++;
        this.log.warn(
          `${name}: skipped "${s.mediaTitle}" S${s.seasonNumber} — ${(e as Error).message}`,
        );
      }
      await yieldLoop();
    }
    if (seasons.length > 0) {
      this.eventsService.emit({
        type: 'task.progress',
        command: name,
        current: seasons.length,
        total: seasons.length,
        message: name,
      });
    }
    this.log.log(
      `${name}: done — ${detected} marker(s) saved across ${seasons.length - skipped}/${seasons.length} season(s)`,
    );
  }

  /** Shared rescan loop — skip subtitle warmup to avoid queue flooding. */
  private async rescanMediaList(
    mediaList: { id: number; title: string }[],
    commandName: string,
  ): Promise<void> {
    this.log.log(`${commandName}: started — ${mediaList.length} media to scan`);
    let totalUpdated = 0;
    let skipped = 0;
    for (let i = 0; i < mediaList.length; i++) {
      const media = mediaList[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: commandName,
        current: i,
        total: mediaList.length,
        message: media.title,
      });
      try {
        const result = await this.mediaService.rescanFiles(media.id, { skipWarmup: true });
        totalUpdated += result.added + result.removed + result.updated;
      } catch (e) {
        skipped++;
        this.log.warn(
          `${commandName}: skipped "${media.title}" — ${(e as Error).message}`,
        );
      }
      await yieldLoop();
    }
    if (mediaList.length > 0) {
      this.eventsService.emit({
        type: 'task.progress',
        command: commandName,
        current: mediaList.length,
        total: mediaList.length,
        message: commandName,
      });
    }
    this.log.log(
      `${commandName}: scanned ${mediaList.length - skipped}/${mediaList.length} media, ${totalUpdated} change(s), ${skipped} skipped`,
    );
    if (skipped > 0) {
      this.log.warn(`${commandName}: ${skipped} media failed (see WARN lines above per title)`);
    }
  }

  private async doRescanAll(): Promise<void> {
    const allMedia = await this.mediaRepo.find({ select: ['id', 'title'] });
    await this.rescanMediaList(allMedia, 'RescanAll');
  }

  /**
   * Refresh metadata for media that are incomplete, never refreshed, or stale
   * (see METADATA_STALE_AFTER_MONTHS).
   */
  private async doRefreshMissingMetadata(): Promise<void> {
    const apiKey = this.config.get<string>('TMDB_API_KEY', '');
    if (!apiKey?.trim()) {
      this.log.warn('RefreshMissingMetadata: TMDB_API_KEY not configured');
      return;
    }

    const staleMonthsRaw = this.config.get<string>(
      'METADATA_STALE_AFTER_MONTHS',
      '3',
    );
    const staleMonths = Math.max(1, Number.parseInt(staleMonthsRaw, 10) || 3);
    const staleBefore = new Date();
    staleBefore.setMonth(staleBefore.getMonth() - staleMonths);

    const allMedia = await this.mediaRepo.find({
      relations: ['seasons'],
    });

    const isIncomplete = (m: (typeof allMedia)[0]) =>
      !m.posterUrl ||
      !m.overview ||
      (m.type === MediaType.SERIES && (!m.seasons || m.seasons.length === 0));

    const isStaleOrNever = (m: (typeof allMedia)[0]) =>
      m.metadataRefreshedAt == null || m.metadataRefreshedAt < staleBefore;

    const candidates = allMedia.filter(
      (m) => isIncomplete(m) || isStaleOrNever(m),
    );

    let updated = 0;
    for (let i = 0; i < candidates.length; i++) {
      const media = candidates[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMissingMetadata',
        current: i,
        total: candidates.length,
        message: media.title,
      });
      try {
        await this.mediaService.refreshMetadata(media.id);
        updated++;
      } catch (e) {
        this.log.warn(
          `RefreshMissingMetadata: failed for "${media.title}": ${(e as Error).message}`,
        );
      }
    }

    if (candidates.length > 0) {
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMissingMetadata',
        current: candidates.length,
        total: candidates.length,
        message: 'RefreshMissingMetadata',
      });
    }

    this.log.log(
      `RefreshMissingMetadata: refreshed ${updated}/${candidates.length} titles (from ${allMedia.length} total)`,
    );
  }

  /**
   * Rescan files only for media that have a configured path but no files in DB,
   * or media whose existing files have no episodeId (series with unlinked files).
   */
  private async doRescanMissingFiles(): Promise<void> {
    const allMedia = await this.mediaRepo.find({
      select: ['id', 'title', 'type', 'rootFolderId', 'folderName'],
      relations: ['files', 'rootFolder'],
    });

    const candidates = allMedia.filter((m) => {
      if (!m.path) return false;
      // No files at all
      if (!m.files || m.files.length === 0) return true;
      // Series with unlinked files (missing episodeId)
      if (
        m.type === MediaType.SERIES &&
        m.files.some((f) => f.episodeId == null)
      )
        return true;
      return false;
    });

    this.log.log(
      `RescanMissingFiles: started — ${candidates.length} media to scan`,
    );

    await this.rescanMediaList(candidates, 'RescanMissingFiles');
  }

  private isDelayed(
    _media: Media,
    publishDate: string,
    delayProfiles: DelayProfile[],
  ): boolean {
    if (!delayProfiles.length) return false;
    // Pick the first profile (lowest order) and apply its delay to all media.
    const profile = delayProfiles[0];
    if (!profile || profile.torrentDelay <= 0) return false;
    const ageHours = (Date.now() - new Date(publishDate).getTime()) / 3_600_000;
    return ageHours < profile.torrentDelay;
  }

  /** Build the async scorer deps for scoreAndSortReleases. */
  private scorerDeps() {
    return {
      scoreCustomFormats: (
        title: string,
        meta: { freeleech?: boolean; downloadVolumeFactor?: number },
      ) => this.customFormats.scoreRelease(title, meta),
      isBlocked: (title: string) => this.blocklist.isBlocked(title),
    };
  }

  private isAvailable(media: Media, today: string): boolean {
    switch (media.minimumAvailability) {
      case MinimumAvailability.ANNOUNCED:
        return true;
      case MinimumAvailability.IN_CINEMAS:
        return !!(media.inCinemas && media.inCinemas <= today);
      case MinimumAvailability.RELEASED:
        return !!(
          (media.digitalRelease && media.digitalRelease <= today) ||
          (media.physicalRelease && media.physicalRelease <= today)
        );
      default:
        return true;
    }
  }
}
