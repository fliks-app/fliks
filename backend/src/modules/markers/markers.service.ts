import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { EpisodeMarker, MarkerType } from './entities/episode-marker.entity';
import { Episode } from '../media/entities/episode.entity';
import { Season } from '../media/entities/season.entity';
import { Command } from '../scheduler/entities/command.entity';
import { EventsService } from '../scheduler/events.service';
import { SettingsService } from '../settings/settings.service';
import { IntroDetectionService } from './intro-detection.service';
import { CreateMarkerDto } from './dto/create-marker.dto';
import { UpdateMarkerDto } from './dto/update-marker.dto';

@Injectable()
export class MarkersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MarkersService.name);
  private rescanSub?: Subscription;
  /** Seasons currently being processed — guards against duplicate enqueues. */
  private readonly inFlight = new Set<number>();

  constructor(
    @InjectRepository(EpisodeMarker)
    private readonly markerRepo: Repository<EpisodeMarker>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    private readonly events: EventsService,
    private readonly settings: SettingsService,
    private readonly detector: IntroDetectionService,
  ) {}

  onModuleInit() {
    // Auto-detect intros after a series rescan brings in new episode files.
    this.rescanSub = this.events.subscribe((event) => {
      if (event.type !== 'rescan.completed') return;
      if (event.added <= 0) return;
      void this.maybeAutoDetect(event.mediaId).catch((err) =>
        this.log.warn(
          `auto intro detection failed for media #${event.mediaId}: ${(err as Error).message}`,
        ),
      );
    });
  }

  onModuleDestroy() {
    this.rescanSub?.unsubscribe();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────────────────────────────────

  findForEpisode(episodeId: number): Promise<EpisodeMarker[]> {
    return this.markerRepo.find({
      where: { episode: { id: episodeId } },
      order: { startSeconds: 'ASC' },
    });
  }

  async findIntroForEpisode(
    episodeId: number,
  ): Promise<EpisodeMarker | null> {
    return this.markerRepo.findOne({
      where: { episode: { id: episodeId }, type: 'intro' },
    });
  }

  async findOutroForEpisode(
    episodeId: number,
  ): Promise<EpisodeMarker | null> {
    return this.markerRepo.findOne({
      where: { episode: { id: episodeId }, type: 'outro' },
    });
  }

  async findForSeason(seasonId: number): Promise<EpisodeMarker[]> {
    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId } },
      select: { id: true },
    });
    if (!episodes.length) return [];
    return this.markerRepo
      .createQueryBuilder('m')
      .where('m."episodeId" IN (:...ids)', { ids: episodes.map((e) => e.id) })
      .orderBy('m."episodeId"', 'ASC')
      .addOrderBy('m."startSeconds"', 'ASC')
      .getMany();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Writes
  // ─────────────────────────────────────────────────────────────────────────

  async create(dto: CreateMarkerDto): Promise<EpisodeMarker> {
    if (dto.endSeconds <= dto.startSeconds) {
      throw new BadRequestException('endSeconds must be > startSeconds');
    }
    // Replace any existing marker of same type for this episode.
    await this.markerRepo.delete({
      episode: { id: dto.episodeId },
      type: dto.type,
    });
    return this.markerRepo.save({
      episode: { id: dto.episodeId },
      type: dto.type,
      startSeconds: dto.startSeconds,
      endSeconds: dto.endSeconds,
      confidence: 1,
      manual: true,
    } as Partial<EpisodeMarker>);
  }

  async update(id: number, dto: UpdateMarkerDto): Promise<EpisodeMarker> {
    const marker = await this.markerRepo.findOne({ where: { id } });
    if (!marker) throw new NotFoundException(`Marker #${id} not found`);
    if (dto.startSeconds != null) marker.startSeconds = dto.startSeconds;
    if (dto.endSeconds != null) marker.endSeconds = dto.endSeconds;
    if (marker.endSeconds <= marker.startSeconds) {
      throw new BadRequestException('endSeconds must be > startSeconds');
    }
    marker.manual = true;
    marker.confidence = 1;
    return this.markerRepo.save(marker);
  }

  async remove(id: number): Promise<void> {
    const result = await this.markerRepo.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`Marker #${id} not found`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Detection orchestration
  // ─────────────────────────────────────────────────────────────────────────

  /** Enqueue an IntroDetection command and run it in the background. */
  async detectSeason(seasonId: number, trigger: 'manual' | 'auto'): Promise<Command> {
    if (this.inFlight.has(seasonId)) {
      throw new BadRequestException(
        `Detection already running for season #${seasonId}`,
      );
    }
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new NotFoundException(`Season #${seasonId} not found`);

    const cmd = await this.commandRepo.save(
      this.commandRepo.create({
        name: 'IntroDetection',
        status: 'queued',
        trigger,
        body: {
          seasonId,
          mediaId: season.mediaId,
          seasonNumber: season.seasonNumber,
        },
      }),
    );
    this.log.log(
      `IntroDetection enqueued (cmd #${cmd.id}, ${trigger}) — season #${seasonId} (S${String(season.seasonNumber).padStart(2, '0')})`,
    );

    // Fire-and-forget.
    void this.runDetection(cmd.id, season.id, season.mediaId, season.seasonNumber).catch(
      (err) =>
        this.log.error(
          `IntroDetection #${cmd.id} crashed: ${(err as Error).message}`,
          err instanceof Error ? err.stack : err,
        ),
    );
    return cmd;
  }

  /**
   * Return the list of seasons eligible for automatic marker detection
   * (non-special, belonging to a series). When `onlyMissing` is true, returns
   * only seasons with at least one episode lacking an intro OR outro marker.
   */
  async listSeasonsForScan(
    onlyMissing: boolean,
  ): Promise<{ id: number; mediaId: number; seasonNumber: number; mediaTitle: string }[]> {
    if (!onlyMissing) {
      const rows: {
        id: number;
        mediaId: number;
        seasonNumber: number;
        mediaTitle: string;
      }[] = await this.seasonRepo.query(`
        SELECT s.id, s."mediaId", s."seasonNumber", m.title AS "mediaTitle"
        FROM seasons s
        JOIN media m ON m.id = s."mediaId"
        WHERE s."seasonNumber" > 0 AND m.type = 'series'
        ORDER BY m.title ASC, s."seasonNumber" ASC
      `);
      return rows;
    }
    const rows: {
      id: number;
      mediaId: number;
      seasonNumber: number;
      mediaTitle: string;
    }[] = await this.seasonRepo.query(`
      SELECT DISTINCT s.id, s."mediaId", s."seasonNumber", m.title AS "mediaTitle"
      FROM seasons s
      JOIN media m ON m.id = s."mediaId"
      JOIN episodes e ON e."seasonId" = s.id
      WHERE s."seasonNumber" > 0 AND m.type = 'series' AND e."hasFile" = true
        AND (
          NOT EXISTS (SELECT 1 FROM episode_markers em
                      WHERE em."episodeId" = e.id AND em.type = 'intro')
          OR NOT EXISTS (SELECT 1 FROM episode_markers em
                         WHERE em."episodeId" = e.id AND em.type = 'outro')
        )
      ORDER BY m.title ASC, s."seasonNumber" ASC
    `);
    return rows;
  }

  /**
   * Run intro + outro detection for a single season inline (no Command row,
   * no per-season SSE noise). Intended for bulk operations triggered from
   * the admin system page.
   */
  async runDetectionInline(
    seasonId: number,
  ): Promise<{ introsDetected: number; outrosDetected: number }> {
    if (this.inFlight.has(seasonId)) {
      // Concurrent per-series trigger already handles it — don't double-run.
      return { introsDetected: 0, outrosDetected: 0 };
    }
    this.inFlight.add(seasonId);
    try {
      const intros = await this.detector.detectSeasonIntros(seasonId);
      const outros = await this.detector.detectSeasonOutros(seasonId);
      return {
        introsDetected: intros.introsDetected,
        outrosDetected: outros.outrosDetected,
      };
    } finally {
      this.inFlight.delete(seasonId);
    }
  }

  async detectSeries(mediaId: number, trigger: 'manual' | 'auto'): Promise<Command[]> {
    const seasons = await this.seasonRepo.find({
      where: { media: { id: mediaId } },
      order: { seasonNumber: 'ASC' },
    });
    const eligible = seasons.filter((s) => s.seasonNumber > 0);
    this.log.log(
      `Series #${mediaId}: enqueuing intro detection on ${eligible.length} season(s) (${trigger})`,
    );
    const cmds: Command[] = [];
    for (const s of eligible) {
      try {
        cmds.push(await this.detectSeason(s.id, trigger));
      } catch (err) {
        this.log.warn(
          `enqueue intro detection skipped for season #${s.id}: ${(err as Error).message}`,
        );
      }
    }
    return cmds;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  private async runDetection(
    cmdId: number,
    seasonId: number,
    mediaId: number,
    seasonNumber: number,
  ): Promise<void> {
    this.inFlight.add(seasonId);
    await this.commandRepo.update(cmdId, {
      status: 'running',
      startedOn: new Date(),
    });
    this.events.emit({ type: 'command.started', name: 'IntroDetection' });

    let detected = 0;
    try {
      const result = await this.detector.detectSeasonIntros(
        seasonId,
        (current, total, message) => {
          this.events.emit({
            type: 'task.progress',
            command: 'IntroDetection',
            current,
            total,
            message,
          });
        },
      );
      detected = result.introsDetected;
      // Same command also runs outro detection (chapter + fingerprint).
      try {
        const outroResult = await this.detector.detectSeasonOutros(
          seasonId,
          (current, total, message) => {
            this.events.emit({
              type: 'task.progress',
              command: 'IntroDetection',
              current,
              total,
              message,
            });
          },
        );
        detected += outroResult.outrosDetected;
      } catch (err) {
        this.log.warn(
          `Outro detection failed for season #${seasonId}: ${(err as Error).message}`,
        );
      }
      await this.commandRepo.update(cmdId, {
        status: 'completed',
        endedOn: new Date(),
      });
      this.events.emit({
        type: 'command.completed',
        name: 'IntroDetection',
        status: 'completed',
      });
      this.events.emit({
        type: 'markers.season.completed',
        mediaId,
        seasonId,
        seasonNumber,
        introsDetected: detected,
      });
    } catch (err) {
      this.log.error(
        `IntroDetection failed for season #${seasonId}: ${(err as Error).message}`,
      );
      await this.commandRepo.update(cmdId, {
        status: 'failed',
        endedOn: new Date(),
      });
      this.events.emit({
        type: 'command.completed',
        name: 'IntroDetection',
        status: 'failed',
      });
    } finally {
      this.inFlight.delete(seasonId);
    }
  }

  private async maybeAutoDetect(mediaId: number): Promise<void> {
    const enabled = (await this.settings.get('enableAutoIntroDetection')) ?? 'true';
    if (enabled !== 'true') return;
    // Only series have seasons; movies skipped naturally because findOne
    // below returns no seasons.
    const seasons = await this.seasonRepo.find({
      where: { media: { id: mediaId } },
    });
    for (const s of seasons.filter((x) => x.seasonNumber > 0)) {
      try {
        await this.detectSeason(s.id, 'auto');
      } catch (err) {
        // already in flight or invalid — just move on
        this.log.debug(
          `auto detect skipped season #${s.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}

export type { MarkerType };
