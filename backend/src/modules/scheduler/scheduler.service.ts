import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
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
import { MediaType, MediaStatus } from '../../common/enums';
import { ConfigService } from '@nestjs/config';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { EventsService } from './events.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { ThumbnailService } from '../streaming/thumbnail.service';
import { MarkersService } from '../markers/markers.service';
import { PostImportService } from './post-import.service';
import { CORE_TRIGGER_ONLY_JOB_NAMES, CoreSchedulerJobName, PLUGIN_SOURCE_REFRESH_CRON } from '../../common/constants/core-scheduler-jobs';
import { PluginJobsService } from '../plugins/plugin-jobs.service';
import { ScheduledJobRegistry } from './scheduled-job-registry.service';
import { PluginCatalogClientService } from '../plugins/plugin-catalog-client.service';
import { PluginAutoUpdateService } from '../plugins/plugin-auto-update.service';
import { runAuditedCommand } from './command-audit.util';

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
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    private readonly tmdb: TmdbProvider,
    private readonly mediaService: MediaService,
    private readonly config: ConfigService,
    private readonly eventsService: EventsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly thumbnailService: ThumbnailService,
    private readonly markers: MarkersService,
    private readonly pluginJobs: PluginJobsService,
    private readonly jobRegistry: ScheduledJobRegistry,
    private readonly catalogClient: PluginCatalogClientService,
    private readonly pluginAutoUpdate: PluginAutoUpdateService,
    private readonly postImport: PostImportService,
  ) {}

  // ---------------------------------------------------------------------------
  // Scheduler definitions
  // ---------------------------------------------------------------------------

  // `name` is typed against `CoreSchedulerJobName` so adding a job here without mirroring
  // its name there (needed so a plugin job can be refused for colliding with it) fails to typecheck.
  // A plugin's own jobs aren't listed here — they come from `jobRegistry` instead,
  // present only when a plugin registered them.
  private static readonly SCHEDULERS: {
    name: CoreSchedulerJobName;
    cron: string;
    triggerable: boolean;
    labelKey: string;
  }[] = [
    {
      name: 'RefreshMetadata',
      cron: CronExpression.EVERY_DAY_AT_4AM,
      triggerable: true,
      labelKey: 'system.cmd_refresh_metadata',
    },
    {
      name: 'RefreshPluginSources',
      cron: PLUGIN_SOURCE_REFRESH_CRON,
      triggerable: true,
      labelKey: 'system.cmd_refresh_plugin_sources',
    },
    {
      name: 'SubtitleSearch',
      cron: CronExpression.EVERY_6_HOURS,
      triggerable: true,
      labelKey: 'system.cmd_subtitle_search',
    },
    {
      name: 'SubtitleUpgrade',
      cron: CronExpression.EVERY_6_HOURS,
      triggerable: true,
      labelKey: 'system.cmd_subtitle_upgrade',
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

  /** Refresh metadata for all media once a day */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshMetadata(): Promise<void> {
    return this.runCommand('RefreshMetadata', 'scheduled', () =>
      this.doRefreshMetadata(),
    );
  }

  /** Internal housekeeping, not in `SCHEDULERS` — nothing to trigger or list for it. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneOldCommands(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.commandRepo
      .createQueryBuilder()
      .delete()
      .where('"createdAt" < :cutoff', { cutoff })
      .execute();
    this.log.log(
      `PruneOldCommands: deleted ${result.affected ?? 0} command(s) older than 30 days`,
    );
  }

  /** Re-fetch every enabled plugin source's catalog once a day. Driven from here rather than
   *  from a bare `@Cron` on the catalog client so the run is listed, triggerable and recorded
   *  like every other scheduled job. */
  @Cron(PLUGIN_SOURCE_REFRESH_CRON)
  async refreshPluginSources(): Promise<void> {
    return this.runCommand('RefreshPluginSources', 'scheduled', async () => {
      await this.catalogClient.refreshAll();
      // Reads the freshly cached catalogs; a no-op unless an admin opted in.
      await this.pluginAutoUpdate.run();
    });
  }

  // ---------------------------------------------------------------------------
  // Manual trigger
  // ---------------------------------------------------------------------------

  async getSchedulers(): Promise<
    {
      name: string;
      cron: string;
      triggerable: boolean;
      labelKey: string;
      lastRun: Date | null;
      lastStatus: string | null;
      nextRun: Date;
      /** `null` for a core job; the owning plugin's id for one it declared. */
      pluginId: string | null;
    }[]
  > {
    // A plugin's registered jobs merge in here exactly like core's own three —
    // `jobRegistry` is simply empty when nothing has published to it.
    const available = [
      ...SchedulerService.SCHEDULERS,
      ...this.jobRegistry.list(),
    ];
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
        labelKey: s.labelKey,
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
      labelKey: job.labelKey,
      lastRun: null,
      lastStatus: null,
      nextRun: CronExpressionParser.parse(job.cron).next().toDate(),
      pluginId,
    }));

    return [...core, ...plugins];
  }

  async triggerCommand(name: string): Promise<Command | { ok: true }> {
    const known = [
      ...SchedulerService.SCHEDULERS.filter((s) => s.triggerable).map(
        (s) => s.name,
      ),
      ...this.jobRegistry
        .list()
        .filter((j) => j.triggerable)
        .map((j) => j.name),
      ...CORE_TRIGGER_ONLY_JOB_NAMES,
    ];
    if (!known.includes(name)) {
      // Registration refuses every reserved core name, so a match here is a plugin's own job.
      const declared = this.pluginJobs
        .listDeclared()
        .find((d) => d.job.name === name);
      if (declared) {
        const result = this.pluginJobs.trigger(declared.pluginId, name);
        if (result.ok) return { ok: true };
        if (result.reason === 'already-running') {
          throw new ConflictException(`Job "${name}" is already running`);
        }
        throw new BadRequestException(`Job "${name}" is ${result.reason.replace('-', ' ')}`);
      }
      // A caller-input error (unknown name, or a job its owning plugin just
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
    return runAuditedCommand(
      this.commandRepo,
      this.eventsService,
      name,
      trigger,
      fn,
      this.log,
    );
  }

  private async dispatchCommand(name: string, cmdId: number): Promise<void> {
    await this.commandRepo.update(cmdId, {
      status: 'running',
      startedOn: new Date(),
    });
    this.eventsService.emit({ type: 'command.started', name });
    try {
      const registered = this.jobRegistry.get(name);
      if (registered) await registered.run();
      else if (name === 'RefreshMetadata') await this.doRefreshMetadata();
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
    const now = new Date();
    const dueMedia = allMedia.filter((m) => this.isMetadataDue(m, now));
    const skipped = allMedia.length - dueMedia.length;
    this.log.log(
      `RefreshMetadata: starting refresh for ${dueMedia.length}/${allMedia.length} media (${skipped} settled title(s) skipped)`,
    );
    let updated = 0;

    for (let i = 0; i < dueMedia.length; i++) {
      const media = dueMedia[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMetadata',
        current: i,
        total: dueMedia.length,
        message: media.title,
      });
      this.log.log(
        `RefreshMetadata: refreshing "${media.title}" (${i + 1}/${dueMedia.length})`,
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

    if (dueMedia.length > 0) {
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RefreshMetadata',
        current: dueMedia.length,
        total: dueMedia.length,
        message: 'RefreshMetadata',
      });
    }

    this.log.log(
      `RefreshMetadata: updated ${updated}/${dueMedia.length} titles (${skipped} skipped)`,
    );
  }

  /** A year-old-plus movie or an ended/cancelled series is "settled" — cheap to
   *  believe unchanged, so it's only worth re-hitting the provider weekly. */
  private isMetadataDue(media: Media, now: Date): boolean {
    const settled =
      media.type === MediaType.MOVIE
        ? this.releasedOverAYearAgo(media, now)
        : media.status === MediaStatus.ENDED;
    if (!settled) return true;
    if (!media.metadataRefreshedAt) return true;
    const ageMs = now.getTime() - media.metadataRefreshedAt.getTime();
    return ageMs >= 7 * 24 * 60 * 60 * 1000;
  }

  private releasedOverAYearAgo(media: Media, now: Date): boolean {
    const releaseDate = media.releaseDate
      ? new Date(media.releaseDate)
      : media.year
        ? new Date(media.year, 0, 1)
        : null;
    if (!releaseDate || Number.isNaN(releaseDate.getTime())) return false;
    return now.getTime() - releaseDate.getTime() > 365 * 24 * 60 * 60 * 1000;
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
          return await this.postImport.generateSprite(id, force);
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
