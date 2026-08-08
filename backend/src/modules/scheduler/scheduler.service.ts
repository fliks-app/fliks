import {
  forwardRef,
  Inject,
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
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { MediaService } from '../media/media.service';
import { onDiskEpisodeNumbers } from '../media/episode-coverage.util';
import { MediaStatus, MediaType, MinimumAvailability } from '../../common/enums';
import { ConfigService } from '@nestjs/config';
import { CompletionService } from './completion.service';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { DelayProfile } from '../profiles/entities/delay-profile.entity';
import { EventsService } from './events.service';
import { MediaFile } from '../media/entities/media-file.entity';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../streaming/thumbnail.service';
import {
  AutoGrabPipelineService,
  AutoGrabScoringContext,
} from '../media/auto-grab-pipeline.service';
import {
  AcquisitionCandidatesService,
  SeasonPackTarget,
} from '../media/acquisition-candidates.service';
import { MarkersService } from '../markers/markers.service';
import {
  ReleaseCandidate,
  releaseMatchesMedia,
  resolveSearchTitles,
} from '../../common/release-scoring';
import { parseSeasonEpisode, matchesSeasonPack } from '../../common/release-parsing';

// Note: scoring/profile/blocklist/quality-definition wiring lives in
// AutoGrabPipelineService. This file only orchestrates the high-level
// scheduler tasks (cron loops, candidate queries) and delegates each
// grab attempt to `this.autoGrab.tryAutoGrab(...)`.

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
    @Inject(forwardRef(() => CompletionService))
    private readonly completion: CompletionService,
    @InjectRepository(DelayProfile)
    private readonly delayProfileRepo: Repository<DelayProfile>,
    private readonly eventsService: EventsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly thumbnailService: ThumbnailService,
    private readonly markers: MarkersService,
    private readonly autoGrab: AutoGrabPipelineService,
    private readonly candidates: AcquisitionCandidatesService,
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

    // Single subscriber for every acquisition-side trigger — see the five
    // `media.acquisition.requested` emitters across media/download-clients/requests.
    this.eventsService.onDomain((event) => {
      if (event.type !== 'media.acquisition.requested') return;
      void this.searchMissingForMedia(event.mediaIds);
    });
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

  /**
   * Targeted, fire-and-forget search for one or more media ids. Used
   * by the request lifecycle right after an approval-driven import so
   * the user doesn't wait for the next scheduled SearchMissing tick
   * (up to 6 h). Bypasses the Command row on purpose — the audit
   * trail for this trigger lives on the request itself, an extra
   * Command per approval would just clutter the history.
   *
   * Throws on infra misconfiguration (no indexer, no download client)
   * are swallowed and logged: a botched auto-trigger shouldn't take
   * down the approval transaction.
   */
  async searchMissingForMedia(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return;
    try {
      await this.doSearchMissing(mediaIds);
    } catch (e) {
      this.log.warn(
        `searchMissingForMedia([${mediaIds.join(', ')}]) failed: ${(e as Error).message}`,
      );
    }
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
        await this.doSearchMissing(mediaIds);
      } else if (name === 'RefreshMetadata') await this.doRefreshMetadata();
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

  // Only logs when a targeted (request-driven) SearchMissing kicks off,
  // so scheduled bulk runs don't get noisy. The hint tells the user what
  // the candidate query is filtering on when the count is zero.
  private logTargetedCandidateCount(
    scope: 'movies' | 'episodes',
    mediaIds: number[] | undefined,
    count: number,
  ): void {
    if (!mediaIds?.length) return;
    if (count > 0) {
      this.log.log(
        `SearchMissing[${scope}]: ${count} candidate(s) for media IDs [${mediaIds.join(', ')}]`,
      );
      return;
    }
    const hint =
      scope === 'movies'
        ? "check monitored flag, type=movie, and that there's no file already at cutoff"
        : 'check that the series/seasons/episodes are monitored and have an airDate ≤ today';
    this.log.log(
      `SearchMissing[${scope}]: 0 candidates for media IDs [${mediaIds.join(', ')}] — ${hint}`,
    );
  }

  /**
   * Drop indexers in failure / Retry-After cooldown before an auto-grab
   * fan-out, mirroring the interactive search paths. A cooled-down indexer
   * left in the list makes the throttle sleep its queued call out for the
   * full backoff (up to 6h); since the fan-out awaits every indexer, one
   * broken host stalls the whole `Promise.allSettled` and the grab step
   * never runs. Returns [] when every indexer is cooling.
   */
  private readyIndexersOrNone(indexers: Indexer[], context: string): Indexer[] {
    const ready = this.torznab.filterReadyIndexers(indexers);
    if (!ready.length) {
      this.log.warn(
        `${context}: every indexer is in cooldown — skipping this run`,
      );
    }
    return ready;
  }

  private async doSearchMissing(mediaIds?: number[]): Promise<void> {
    if (mediaIds?.length) {
      this.log.log(
        `SearchMissing: targeted restart for media IDs [${mediaIds.join(', ')}]`,
      );
    }
    const enabledIndexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC' },
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));

    if (!enabledIndexers.length) {
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

    const indexers = this.readyIndexersOrNone(enabledIndexers, 'SearchMissing');
    if (!indexers.length) return;

    await this.searchMissingMovies(indexers, qbitClient, mediaIds);
    await this.searchMissingEpisodes(indexers, qbitClient, mediaIds);
  }

  private async searchMissingMovies(
    indexers: Indexer[],
    qbitClient: DownloadClient,
    mediaIds?: number[],
  ): Promise<void> {
    const targets = await this.candidates.listMovieTargets(mediaIds);

    this.logTargetedCandidateCount('movies', mediaIds, targets.length);
    if (!targets.length) return;

    const today = new Date().toISOString().slice(0, 10);
    const scoring = await this.autoGrab.buildScoringContext(indexers);

    for (let i = 0; i < targets.length; i++) {
      const { media, files } = targets[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: targets.length,
        message: media.title,
      });

      if (!this.isAvailable(media, today)) continue;

      const { searchTitle } = resolveSearchTitles(media);
      const query = [searchTitle, media.year].filter(Boolean).join(' ');
      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchMovie(ix, query, {
            imdbId: media.imdbId,
            tmdbId: media.tmdbId,
          }),
        ),
      );
      const releases = batches
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .filter((r) =>
          releaseMatchesMedia(r.title, media, { requireYearInTitle: true }),
        );

      await this.autoGrab.tryAutoGrab({
        media,
        files,
        releases,
        qbitClient,
        scoring,
        mediaType: 'movie',
        label: media.title,
        runtimeMinutes: media.runtime ?? 0,
        pendingCheck: async () => {
          const pending = await this.historyRepo.findOne({
            where: { media: { id: media.id }, status: 'grabbed' },
          });
          return !!pending;
        },
      });
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: targets.length,
      total: targets.length,
      message: 'SearchMissing',
    });
  }

  private async searchMissingEpisodes(
    indexers: Indexer[],
    qbitClient: DownloadClient,
    mediaIds?: number[],
  ): Promise<void> {
    const scoring = await this.autoGrab.buildScoringContext(indexers);

    const targets = await this.candidates.listEpisodeTargets(mediaIds);

    this.logTargetedCandidateCount('episodes', mediaIds, targets.length);
    if (!targets.length) return;

    // Season-pack-first: a season missing more than one episode is better
    // served by one (usually far better seeded) pack than by scattered
    // per-episode grabs. Episodes a grabbed pack covers drop out of the
    // per-episode search below.
    const packTargets = await this.candidates.groupIntoSeasonPacks(targets);
    const coveredByPack = await this.grabMissingSeasonPacks(
      packTargets,
      indexers,
      qbitClient,
      scoring,
    );
    const toSearch = coveredByPack.size
      ? targets.filter((t) => !coveredByPack.has(t.episode.id))
      : targets;

    for (let i = 0; i < toSearch.length; i++) {
      const { media, season, episode: ep, files } = toSearch[i];
      const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;

      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: toSearch.length,
        message: `${media.title} ${epLabel}`,
      });

      const { searchTitle } = resolveSearchTitles(media);
      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeries(
            ix,
            searchTitle,
            season.seasonNumber,
            ep.episodeNumber,
            { tvdbId: media.tvdbId, imdbId: media.imdbId },
          ),
        ),
      );
      const releases = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );

      await this.autoGrab.tryAutoGrab({
        media,
        files,
        releases,
        qbitClient,
        scoring,
        mediaType: 'series',
        label: `${media.title} ${epLabel}`,
        // Episodes are typically 20-60 min; 30 min fallback for size check.
        runtimeMinutes: media.runtime ?? 30,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        seasonId: season.id,
        episodeId: ep.id,
        pendingCheck: async () => {
          const pending = await this.historyRepo
            .createQueryBuilder('h')
            .where('h.mediaId = :mediaId', { mediaId: media.id })
            .andWhere('h.status = :status', { status: 'grabbed' })
            .andWhere(`h.sourceTitle ILIKE :pattern`, {
              pattern: `%${epLabel}%`,
            })
            .getOne();
          return !!pending;
        },
      });
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: toSearch.length,
      total: toSearch.length,
      message: 'SearchMissing',
    });
  }

  /**
   * Season-pack-first pass for SearchMissing. For each candidate pack, tries
   * to grab a single full-season release instead of scattered per-episode
   * releases — packs are usually far better seeded and import per-file.
   * Returns the ids of the episodes a grabbed pack now covers so the caller
   * skips their per-episode search.
   */
  private async grabMissingSeasonPacks(
    packs: SeasonPackTarget[],
    indexers: Indexer[],
    qbitClient: DownloadClient,
    scoring: AutoGrabScoringContext,
  ): Promise<Set<number>> {
    const covered = new Set<number>();

    for (const {
      season,
      media,
      episodes: eps,
      files,
      totalEpisodeCount,
    } of packs) {
      const seasonLabel = `S${String(season.seasonNumber).padStart(2, '0')}`;

      // A grabbed pack records a season-scoped history row (no episodeId). If
      // one is already downloading, the episodes are already covered: mark
      // them so the per-episode pass doesn't grab singles alongside the pack
      // (that pass keys off the episode tag, which a pack title doesn't carry).
      const packPending = await this.historyRepo
        .createQueryBuilder('h')
        .where('h.mediaId = :mediaId', { mediaId: media.id })
        .andWhere('h.status = :status', { status: 'grabbed' })
        .andWhere('h.seasonId = :seasonId', { seasonId: season.id })
        .andWhere('h.episodeId IS NULL')
        .getOne();
      if (packPending) {
        for (const ep of eps) covered.add(ep.id);
        continue;
      }

      const { searchTitle } = resolveSearchTitles(media);
      const packBatches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeasonPack(ix, searchTitle, season.seasonNumber, {
            tvdbId: media.tvdbId,
            imdbId: media.imdbId,
          }),
        ),
      );
      // Indexer `season=` filtering is unreliable (notably text-mode
      // backends), so keep only releases that parse as a full-season pack —
      // never a stray single episode that slipped into the result set.
      const packReleases = packBatches
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .filter((r) => matchesSeasonPack(r.title, season.seasonNumber));
      if (!packReleases.length) continue;

      const grabbed = await this.autoGrab.tryAutoGrab({
        media,
        files,
        releases: packReleases,
        qbitClient,
        scoring,
        mediaType: 'series',
        label: `${media.title} ${seasonLabel} (pack)`,
        runtimeMinutes: (media.runtime ?? 45) * totalEpisodeCount,
        seasonNumber: season.seasonNumber,
        seasonId: season.id,
      });
      if (grabbed) {
        for (const ep of eps) covered.add(ep.id);
        this.log.log(
          `SearchMissing: grabbed a ${media.title} ${seasonLabel} pack covering ${eps.length} missing episode(s)`,
        );
      }
    }

    return covered;
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

  private async doRssSync(): Promise<void> {
    const enabledIndexers = await this.indexerRepo.find({
      where: { enabled: true, enableRss: true },
      order: { priority: 'ASC' },
    });

    if (!enabledIndexers.length) return;

    const indexers = this.readyIndexersOrNone(enabledIndexers, 'RssSync');
    if (!indexers.length) return;

    // Full candidates (with profiles + files) so RSS reuses the exact same
    // missing/upgrade pipeline as SearchMissing: title match → classify →
    // score → autoGrabAndRecord. Series candidates also include seasons +
    // episodes so we can match a release against the right `(season, ep)`
    // and apply the season-pack-first priority logic below.
    const movieCandidates = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .leftJoinAndSelect('m.files', 'f')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('(f.id IS NULL OR qp."upgradeAllowed" = true)')
      .getMany();

    const seriesCandidates = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .leftJoinAndSelect('m.seasons', 's')
      .leftJoinAndSelect('s.episodes', 'e')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.SERIES })
      .getMany();

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

    const scoring = await this.autoGrab.buildScoringContext(indexers);
    const delayProfiles = await this.delayProfileRepo.find({
      order: { order: 'ASC' },
    });
    const today = new Date().toISOString().slice(0, 10);

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
        // Phase 1: within this feed pull, season packs win over individual
        // episodes of the same season. Sort packs first; track packs we
        // hand to autoGrab so subsequent same-season episodes are skipped.
        const sorted = [...results].sort((a, b) => {
          const pa = parseSeasonEpisode(a.title);
          const pb = parseSeasonEpisode(b.title);
          if (pa.isFullSeason !== pb.isFullSeason)
            return pa.isFullSeason ? -1 : 1;
          const da = a.publishDate ? new Date(a.publishDate).getTime() : 0;
          const db = b.publishDate ? new Date(b.publishDate).getTime() : 0;
          return db - da;
        });
        const packTriedThisPull = new Set<string>();
        for (const release of sorted) {
          const parsed = parseSeasonEpisode(release.title);
          const movieMatch = this.matchMovieRelease(release, movieCandidates);
          if (movieMatch) {
            // Same availability gate as SearchMissing: don't grab a title
            // that hasn't reached its minimum availability yet.
            if (!this.isAvailable(movieMatch, today)) continue;
            if (this.releaseTooFresh(release, movieMatch, delayProfiles))
              continue;
            await this.grabRssRelease({
              media: movieMatch,
              files: movieMatch.files ?? [],
              release,
              qbitClient,
              scoring,
              mediaType: 'movie',
              label: movieMatch.title,
              runtimeMinutes: movieMatch.runtime ?? 0,
              extraPendingCheck: async () => {
                const pending = await this.historyRepo.findOne({
                  where: { media: { id: movieMatch.id }, status: 'grabbed' },
                });
                return !!pending;
              },
            });
            continue;
          }

          // Series — require a recognisable season; no year guard (shows
          // span multiple years).
          if (parsed.season == null) continue;
          const seriesMatch = this.matchSeriesRelease(
            release,
            seriesCandidates,
          );
          if (!seriesMatch) continue;
          const season = seriesMatch.seasons?.find(
            (s) => s.seasonNumber === parsed.season,
          );
          if (!season) continue;
          const packKey = `${seriesMatch.id}:${parsed.season}`;
          const onDiskNums = onDiskEpisodeNumbers(season.episodes ?? []);

          if (parsed.isFullSeason) {
            // A pack is only worth grabbing when it covers a monitored,
            // not-on-disk episode that has already aired — mirroring the
            // airDate gate SearchMissing applies per episode.
            const wanted = (season.episodes ?? []).some(
              (e) =>
                e.monitored &&
                !onDiskNums.has(e.episodeNumber) &&
                !!e.airDate &&
                e.airDate <= today,
            );
            if (!wanted) continue;
            packTriedThisPull.add(packKey);
            await this.grabRssRelease({
              media: seriesMatch,
              files: [],
              release,
              qbitClient,
              scoring,
              mediaType: 'series',
              label: `${seriesMatch.title} S${String(parsed.season).padStart(2, '0')}`,
              runtimeMinutes: seriesMatch.runtime ?? 30,
              seasonNumber: parsed.season,
              extraPendingCheck: () =>
                this.hasRecentSeasonPackGrab(seriesMatch.id, parsed.season!),
            });
            continue;
          }

          if (parsed.episode == null) continue;
          const ep = (season.episodes ?? []).find(
            (e) => e.episodeNumber === parsed.episode,
          );
          if (!ep || !ep.monitored || onDiskNums.has(ep.episodeNumber))
            continue;
          // Don't grab an episode that hasn't aired yet — same airDate gate
          // SearchMissing enforces in its query.
          if (!ep.airDate || ep.airDate > today) continue;
          // Intra-pull Phase 1: a pack for this season was already handed
          // off above; skip the individual episode.
          if (packTriedThisPull.has(packKey)) continue;
          // Phase 2: give a pack time to appear before grabbing a single
          // episode. The DelayProfile's torrentDelay (hours) is the
          // grace window measured against the release's publishDate.
          if (this.releaseTooFresh(release, seriesMatch, delayProfiles))
            continue;
          const epLabel = `S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`;
          await this.grabRssRelease({
            media: seriesMatch,
            files: [],
            release,
            qbitClient,
            scoring,
            mediaType: 'series',
            label: `${seriesMatch.title} ${epLabel}`,
            runtimeMinutes: seriesMatch.runtime ?? 30,
            seasonNumber: parsed.season,
            extraPendingCheck: async () => {
              // Cross-pull Phase 2: a pack was already grabbed for this
              // season in a previous pull — the episode is now redundant.
              if (
                await this.hasRecentSeasonPackGrab(
                  seriesMatch.id,
                  parsed.season!,
                )
              )
                return true;
              const epDup = await this.historyRepo
                .createQueryBuilder('h')
                .where('h.mediaId = :mediaId', { mediaId: seriesMatch.id })
                .andWhere('h.status = :status', { status: 'grabbed' })
                .andWhere('h.sourceTitle ILIKE :pattern', {
                  pattern: `%${epLabel}%`,
                })
                .getOne();
              return !!epDup;
            },
          });
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

  /** Token match via {@link resolveSearchTitles} + year guard for movies.
   *  Short common titles ("Up", "It", "Heat", "Cars") otherwise match
   *  dozens of unrelated releases. Series skip the year guard — air-year
   *  mismatch is common across multi-season shows; the caller already
   *  requires a recognisable season in the release title. */
  private matchReleaseToMedia(
    release: ReleaseCandidate,
    candidates: Media[],
    yearGuard: boolean,
  ): Media | undefined {
    return candidates.find((m) =>
      releaseMatchesMedia(release.title, m, {
        requireYearInTitle: yearGuard,
      }),
    );
  }

  private matchMovieRelease(
    release: ReleaseCandidate,
    candidates: Media[],
  ): Media | undefined {
    return this.matchReleaseToMedia(release, candidates, true);
  }

  private matchSeriesRelease(
    release: ReleaseCandidate,
    candidates: Media[],
  ): Media | undefined {
    return this.matchReleaseToMedia(release, candidates, false);
  }

  private releaseTooFresh(
    release: ReleaseCandidate,
    media: Media,
    delayProfiles: DelayProfile[],
  ): boolean {
    return (
      !!release.publishDate &&
      this.isDelayed(media, release.publishDate, delayProfiles)
    );
  }

  /** RSS auto-grab wrapper — fills in fields shared by every release in
   *  the feed loop (source-title dedup) and forwards the rest to
   *  {@link AutoGrabPipelineService.tryAutoGrab}. */
  private async grabRssRelease(args: {
    media: Media;
    files: { quality?: string | null }[];
    release: ReleaseCandidate;
    qbitClient: DownloadClient;
    scoring: AutoGrabScoringContext;
    mediaType: 'movie' | 'series';
    label: string;
    runtimeMinutes: number;
    /** Season targeted by the matched release — forwarded so the
     *  request-lifecycle hook flips only the matching per-season
     *  requests when the grab succeeds. */
    seasonNumber?: number;
    /** Extra grab-dedup logic on top of the same-source-title check. */
    extraPendingCheck?: () => Promise<boolean>;
  }): Promise<boolean> {
    return this.autoGrab.tryAutoGrab({
      media: args.media,
      files: args.files,
      releases: [args.release],
      qbitClient: args.qbitClient,
      scoring: args.scoring,
      mediaType: args.mediaType,
      label: args.label,
      runtimeMinutes: args.runtimeMinutes,
      seasonNumber: args.seasonNumber,
      pendingCheck: async () => {
        // Same release in history — happens because the same item
        // re-appears across feed polls.
        const dup = await this.historyRepo.findOne({
          where: {
            media: { id: args.media.id },
            sourceTitle: args.release.title,
          },
        });
        if (dup) return true;
        return args.extraPendingCheck ? args.extraPendingCheck() : false;
      },
    });
  }

  /**
   * RSS Phase-2 helper: true when a season-pack release for
   * `(mediaId, seasonNumber)` was already grabbed within the last 24h.
   * Parses each recent history row's `sourceTitle` so we don't need a
   * dedicated `pending_release` table — the source-title itself is the
   * source of truth for what was grabbed.
   */
  private async hasRecentSeasonPackGrab(
    mediaId: number,
    seasonNumber: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await this.historyRepo
      .createQueryBuilder('h')
      .where('h.mediaId = :mediaId', { mediaId })
      .andWhere('h.status = :status', { status: 'grabbed' })
      .andWhere('h.createdAt >= :since', { since })
      .getMany();
    return recent.some((r) => {
      const p = parseSeasonEpisode(r.sourceTitle ?? '');
      return p.isFullSeason && p.season === seasonNumber;
    });
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

  private isAvailable(media: Media, today: string): boolean {
    switch (media.minimumAvailability) {
      case MinimumAvailability.ANNOUNCED:
        return true;
      case MinimumAvailability.IN_CINEMAS:
        return !!(media.inCinemas && media.inCinemas <= today);
      case MinimumAvailability.RELEASED:
        // Home-media dates first, then fall back to the cinema date plus a
        // grace window, the primary release date, and finally the catalogue
        // status — so titles whose digital/physical dates are absent from the
        // metadata source (typical for older catalogue films) still resolve.
        if (media.digitalRelease && media.digitalRelease <= today) return true;
        if (media.physicalRelease && media.physicalRelease <= today)
          return true;
        if (media.inCinemas && this.addDaysIso(media.inCinemas, 90) <= today)
          return true;
        if (media.releaseDate && media.releaseDate <= today) return true;
        return media.status === MediaStatus.RELEASED;
      default:
        return true;
    }
  }

  private addDaysIso(isoDate: string, days: number): string {
    const d = new Date(isoDate);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
