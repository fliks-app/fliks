import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduledJobRegistry } from '../../scheduler/scheduled-job-registry.service';
import { Command } from '../../scheduler/entities/command.entity';
import { EventsService } from '../../scheduler/events.service';
import { runAuditedCommand } from '../../scheduler/command-audit.util';
import { LiveTvSourcesService } from './livetv-sources.service';
import { LiveTvGuideService } from './livetv-guide.service';

/**
 * Ticks hourly (daily for the prune) on a fixed cadence; each row decides for
 * itself whether anything actually happens, by comparing its own
 * `refreshIntervalHours` against its `lastSyncAt`. Also registers with
 * {@link ScheduledJobRegistry} so the jobs are listed and manually
 * triggerable like every core scheduled job.
 */
@Injectable()
export class LiveTvSchedulerService implements OnModuleInit {
  private readonly log = new Logger(LiveTvSchedulerService.name);

  constructor(
    private readonly jobRegistry: ScheduledJobRegistry,
    private readonly sources: LiveTvSourcesService,
    private readonly guide: LiveTvGuideService,
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    private readonly events: EventsService,
  ) {}

  /** Cron-only wrapper: a manual trigger already gets its own Command row
   *  around `run()` (see {@link ScheduledJobRegistry}), so wrapping it here too would double it. */
  private runAudited(name: string, fn: () => Promise<void>): Promise<void> {
    return runAuditedCommand(this.commandRepo, this.events, name, 'scheduled', fn, this.log);
  }

  onModuleInit(): void {
    this.jobRegistry.register([
      {
        name: 'LiveTvSourceRefresh',
        cron: CronExpression.EVERY_HOUR,
        triggerable: true,
        labelKey: 'livetv.jobs.sourceRefresh',
        run: () => this.refreshSources(),
      },
      {
        name: 'LiveTvGuideRefresh',
        cron: CronExpression.EVERY_HOUR,
        triggerable: true,
        labelKey: 'livetv.jobs.guideRefresh',
        run: () => this.refreshGuides(),
      },
      {
        name: 'LiveTvGuidePrune',
        cron: CronExpression.EVERY_DAY_AT_1AM,
        triggerable: true,
        labelKey: 'livetv.jobs.guidePrune',
        run: () => this.pruneGuide(),
      },
    ]);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async refreshSourcesCron(): Promise<void> {
    return this.runAudited('LiveTvSourceRefresh', () => this.refreshSources());
  }

  async refreshSources(): Promise<void> {
    const sources = await this.sources.findAll();
    for (const source of sources) {
      if (!source.enabled || !this.isDue(source.lastSyncAt, source.refreshIntervalHours)) continue;
      await this.sources.sync(source.id);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async refreshGuidesCron(): Promise<void> {
    return this.runAudited('LiveTvGuideRefresh', () => this.refreshGuides());
  }

  async refreshGuides(): Promise<void> {
    const guideSources = await this.guide.findAll();
    for (const guideSource of guideSources) {
      if (
        !guideSource.enabled ||
        !this.isDue(guideSource.lastSyncAt, guideSource.refreshIntervalHours)
      ) {
        continue;
      }
      await this.guide.syncGuideSource(guideSource.id);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async pruneGuideCron(): Promise<void> {
    return this.runAudited('LiveTvGuidePrune', () => this.pruneGuide());
  }

  async pruneGuide(): Promise<void> {
    const { removed } = await this.guide.prune();
    this.log.log(`Guide prune: removed ${removed} stale program(s)`);
  }

  private isDue(lastSyncAt: Date | null, refreshIntervalHours: number): boolean {
    if (!lastSyncAt) return true;
    return Date.now() - lastSyncAt.getTime() >= refreshIntervalHours * 3600_000;
  }
}
