import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledJobRegistry } from '../../scheduler/scheduled-job-registry.service';
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
  ) {}

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
  async refreshSources(): Promise<void> {
    const sources = await this.sources.findAll();
    for (const source of sources) {
      if (!source.enabled || !this.isDue(source.lastSyncAt, source.refreshIntervalHours)) continue;
      await this.sources.sync(source.id);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
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
  async pruneGuide(): Promise<void> {
    const { removed } = await this.guide.prune();
    this.log.log(`Guide prune: removed ${removed} stale program(s)`);
  }

  private isDue(lastSyncAt: Date | null, refreshIntervalHours: number): boolean {
    if (!lastSyncAt) return true;
    return Date.now() - lastSyncAt.getTime() >= refreshIntervalHours * 3600_000;
  }
}
