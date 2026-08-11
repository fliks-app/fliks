import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { existsSync } from 'fs';
import { In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronExpressionParser } from 'cron-parser';
import { Command } from './entities/command.entity';
import { Media } from '../media/entities/media.entity';
import { Episode } from '../media/entities/episode.entity';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { MediaService } from '../media/media.service';
import { MediaType } from '../../common/enums';
import { ConfigService } from '@nestjs/config';
import { CompletionService } from '../../plugins/download/completion.service';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { EventsService } from './events.service';
import { MediaFile } from '../media/entities/media-file.entity';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../streaming/thumbnail.service';
import { MarkersService } from '../markers/markers.service';
import { CORE_SCHEDULER_JOB_NAMES } from '../../common/constants/core-scheduler-jobs';
import { PluginJobsService } from '../plugins/plugin-jobs.service';
import { AcquisitionSchedulerService } from '../../plugins/download/acquisition-scheduler.service';
import { isDownloadBundleEnabled } from '../../common/constants/plugin-flags';

/** Yield the event loop so HTTP requests aren't starved by bulk tasks. */
const yieldLoop = () => new Promise<void>((r) => setTimeout(r, 50));

/** Core jobs that need the download bundle (`plugins/download/`) to run — see FLIKS_BUNDLES. */
const DOWNLOAD_BUNDLE_JOB_NAMES: ReadonlySet<string> = new Set([
  'SearchMissing',
  'RssSync',
  'ImportCompleted',
  'CleanStalled',
  'CleanSeeded',
]);

/** False for a download-bundle job once the bundle is off, so it drops out of the
 *  scheduler listing and can no longer be triggered. `bundleEnabled` defaults to a
 *  fresh env read, and is otherwise a plain parameter for `it.each`-style testing. */
export function isJobAvailable(
  name: string,
  bundleEnabled = isDownloadBundleEnabled(),
): boolean {
  return bundleEnabled || !DOWNLOAD_BUNDLE_JOB_NAMES.has(name);
}

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly log = new Logger(SchedulerService.name);

  constructor(
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    private readonly tmdb: TmdbProvider,
    private readonly mediaService: MediaService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(forwardRef(() => CompletionService))
    private readonly completion: CompletionService | undefined,
    private readonly eventsService: EventsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly thumbnailService: ThumbnailService,
    private readonly markers: MarkersService,
    @Optional()
    private readonly acquisitionScheduler: AcquisitionSchedulerService | undefined,
    private readonly pluginJobs: PluginJobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Scheduler definitions
  // ---------------------------------------------------------------------------

  // `name` is typed against `CORE_SCHEDULER_JOB_NAMES` so adding a job here without mirroring
  // its name there (needed so a plugin job can be refused for colliding with it) fails to typecheck.
  private static readonly SCHEDULERS: {
    name: (typeof CORE_SCHEDULER_JOB_NAMES)[number];
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
      cron: CronExpression.EVERY_5_MINUTES,
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
    const scheduler = this.acquisitionScheduler;
    if (!scheduler) return;
    return this.runCommand('SearchMissing', 'scheduled', () =>
      scheduler.searchMissing(),
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
    const scheduler = this.acquisitionScheduler;
    if (!scheduler) return;
    return this.runCommand('RssSync', 'scheduled', () => scheduler.rssSync());
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
      /** `null` for a core job; the owning plugin's id for one it declared. */
      pluginId: string | null;
    }[]
  > {
    const available = SchedulerService.SCHEDULERS.filter((s) =>
      isJobAvailable(s.name),
    );
    const names = available.map((s) => s.name);

    // Get last command per scheduler name in one query
    const lastCommands = await this.commandRepo
      .createQueryBuilder('c')
      .where('c.name IN (:...names)', { names })
      .andWhere(
        'c.id = (SELECT c2.id FROM commands c2 WHERE c2.name = c.name ORDER BY c2."createdAt" DESC LIMIT 1)',
      )
      .getMany();

    const lastByName = new Map(lastCommands.map((c) => [c.name, c]));

    const core = available.map((s) => {
      const last = lastByName.get(s.name);
      const interval = CronExpressionParser.parse(s.cron);
      return {
        name: s.name,
        cron: s.cron,
        triggerable: s.triggerable,
        lastRun: last?.startedOn ?? null,
        lastStatus: last?.status ?? null,
        nextRun: interval.next().toDate(),
        pluginId: null,
      };
    });

    // Plugin jobs have no `Command` history — core owns that audit trail, a plugin's run does not.
    const plugins = this.pluginJobs.listDeclared().map(({ pluginId, job }) => ({
      name: job.name,
      cron: job.cron,
      triggerable: job.triggerable,
      lastRun: null,
      lastStatus: null,
      nextRun: CronExpressionParser.parse(job.cron).next().toDate(),
      pluginId,
    }));

    return [...core, ...plugins];
  }

  async triggerCommand(name: string): Promise<Command> {
    const known = [
      ...SchedulerService.SCHEDULERS.filter(
        (s) => s.triggerable && isJobAvailable(s.name),
      ).map((s) => s.name),
      'RescanAll',
      'RefreshMissingMetadata',
      'RescanMissingFiles',
      'GenerateSprites',
      'GenerateMissingSprites',
      'DetectMarkers',
      'DetectMissingMarkers',
    ];
    if (!known.includes(name)) {
      // A caller-input error (unknown name, or a job the download bundle just
      // dropped) — not a server fault, so 400 rather than an unhandled throw.
      throw new BadRequestException(
        `Unknown command: ${name}. Valid: ${known.join(', ')}`,
      );
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
    const cmd = await this.commandRepo.findOne({ where: { id: cmdId } });
    const body = cmd?.body ?? {};
    await this.commandRepo.update(cmdId, {
      status: 'running',
      startedOn: new Date(),
    });
    this.eventsService.emit({ type: 'command.started', name });
    try {
      if (name === 'SearchMissing') {
        const mediaIds = Array.isArray(body['mediaIds'])
          ? (body['mediaIds'] as number[])
          : undefined;
        await this.acquisitionScheduler?.searchMissing(mediaIds);
      } else if (name === 'RefreshMetadata') await this.doRefreshMetadata();
      else if (name === 'RssSync') await this.acquisitionScheduler?.rssSync();
      else if (name === 'ImportCompleted')
        await this.completion?.processCompleted();
      else if (name === 'CleanStalled')
        await this.completion?.cleanStalledTorrents();
      else if (name === 'CleanSeeded')
        await this.completion?.cleanSeededTorrents();
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
      : allIds.filter(
          ({ id }) => !existsSync(this.thumbnailService.getMetadataPath(id)),
        );
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
            file,
            file.media,
            label,
            { force, skipTracking: true },
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
        const result = await this.mediaService.rescanFiles(media.id, {
          skipWarmup: true,
        });
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
      this.log.warn(
        `${commandName}: ${skipped} media failed (see WARN lines above per title)`,
      );
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
      select: ['id', 'title', 'type', 'libraryId', 'folderName'],
      relations: ['files', 'library'],
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
}
