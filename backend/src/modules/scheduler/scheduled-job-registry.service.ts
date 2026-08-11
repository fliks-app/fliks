import { Injectable } from '@nestjs/common';
import { CoreSchedulerJobName } from '../../common/constants/core-scheduler-jobs';

export interface RegisteredJob {
  name: CoreSchedulerJobName;
  cron: string;
  triggerable: boolean;
  /** The raw action only — the caller (scheduled tick or manual dispatch)
   *  supplies its own `Command`-row lifecycle around it. */
  run: () => Promise<void>;
}

/**
 * Lets a detachable bundle publish scheduled jobs into the merged
 * `GET /commands/schedulers` listing and manual trigger without core naming
 * or importing the bundle's services. Mirrors `PluginJobsService`'s registry
 * shape for the in-repo, in-process case; empty when the owning bundle isn't
 * loaded, which is what makes the listing shrink automatically.
 */
@Injectable()
export class ScheduledJobRegistry {
  private readonly jobs = new Map<string, RegisteredJob>();

  register(jobs: readonly RegisteredJob[]): void {
    for (const job of jobs) this.jobs.set(job.name, job);
  }

  get(name: string): RegisteredJob | undefined {
    return this.jobs.get(name);
  }

  list(): RegisteredJob[] {
    return [...this.jobs.values()];
  }
}
