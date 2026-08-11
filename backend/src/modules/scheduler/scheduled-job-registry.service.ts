import { Injectable, Logger } from '@nestjs/common';
import { CORE_SCHEDULER_JOB_NAMES } from '../../common/constants/core-scheduler-jobs';

export interface RegisteredJob {
  /** A publisher's own name — the registry only refuses one that collides with a core job. */
  name: string;
  cron: string;
  triggerable: boolean;
  /** i18n key for a manual-trigger button — lets a generic UI render one
   *  without core naming the publisher's jobs. */
  labelKey: string;
  /** The raw action only — the caller (scheduled tick or manual dispatch)
   *  supplies its own `Command`-row lifecycle around it. */
  run: () => Promise<void>;
}

const CORE_JOB_NAMES: ReadonlySet<string> = new Set(CORE_SCHEDULER_JOB_NAMES);

/**
 * Lets a detachable bundle publish scheduled jobs into the merged
 * `GET /commands/schedulers` listing and manual trigger without core naming
 * or importing the bundle's services. Mirrors `PluginJobsService`'s registry
 * shape for the in-repo, in-process case; empty when the owning bundle isn't
 * loaded, which is what makes the listing shrink automatically.
 */
@Injectable()
export class ScheduledJobRegistry {
  private readonly logger = new Logger(ScheduledJobRegistry.name);
  private readonly jobs = new Map<string, RegisteredJob>();

  /** Fails closed: a name colliding with a core job is refused and logged, never stored — a
   *  core job is never in this map to begin with, so it can never be overwritten via it. */
  register(jobs: readonly RegisteredJob[]): void {
    for (const job of jobs) {
      if (CORE_JOB_NAMES.has(job.name)) {
        this.logger.error(
          `refusing to register job "${job.name}" — collides with a core scheduler job`,
        );
        continue;
      }
      this.jobs.set(job.name, job);
    }
  }

  get(name: string): RegisteredJob | undefined {
    return this.jobs.get(name);
  }

  list(): RegisteredJob[] {
    return [...this.jobs.values()];
  }
}
