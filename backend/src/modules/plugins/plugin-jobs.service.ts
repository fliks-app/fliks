import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import { PluginProcessService } from './plugin-process.service';
import { PLUGIN_DEADLINES_MS, type PluginJob } from '../../common/plugin-contract';

/** A sweep's duration scales with library size, not with a request someone is waiting on. */
const JOB_CALL_DEADLINE_MS = PLUGIN_DEADLINES_MS.job;

function cronKey(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`;
}

export type PluginJobTriggerResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-job' | 'not-triggerable' | 'already-running' };

/**
 * Core owns every plugin's cron schedule via `SchedulerRegistry` — the plugin only ever
 * receives the resulting `job` call. `replaceFor`/`dropFor` are this map's only entry and
 * exit, mirroring `PluginRegistryService`'s other per-plugin registries.
 */
@Injectable()
export class PluginJobsService {
  private readonly logger = new Logger(PluginJobsService.name);
  private readonly declared = new Map<string, readonly PluginJob[]>();
  /** Keyed by `cronKey` — shared between a cron tick and a manual trigger so they can't overlap. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly processService: PluginProcessService,
  ) {}

  /** Tears down this plugin's previous crons, if any, then starts one per job in `jobs`. */
  replaceFor(pluginId: string, jobs: readonly PluginJob[]): void {
    this.dropFor(pluginId);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      const cronJob = CronJob.from({
        cronTime: job.cron,
        onTick: () => {
          void this.run(pluginId, job.name);
        },
        start: true,
      });
      this.schedulerRegistry.addCronJob(cronKey(pluginId, job.name), cronJob);
    }
    this.declared.set(pluginId, jobs);
  }

  /** Idempotent — a no-op for a plugin with no crons currently registered. */
  dropFor(pluginId: string): void {
    const jobs = this.declared.get(pluginId);
    if (!jobs) return;
    for (const job of jobs) {
      const key = cronKey(pluginId, job.name);
      if (this.schedulerRegistry.doesExist('cron', key)) this.schedulerRegistry.deleteCronJob(key);
    }
    this.declared.delete(pluginId);
  }

  /** Every plugin's declared jobs, for the merged admin scheduler listing. */
  listDeclared(): { pluginId: string; job: PluginJob }[] {
    const out: { pluginId: string; job: PluginJob }[] = [];
    for (const [pluginId, jobs] of this.declared) {
      for (const job of jobs) out.push({ pluginId, job });
    }
    return out;
  }

  declaredJob(pluginId: string, name: string): PluginJob | undefined {
    return this.declared.get(pluginId)?.find((j) => j.name === name);
  }

  /** Manual run. Fire-and-forget like `SchedulerService.triggerCommand` — the caller gets an
   *  immediate verdict, never a promise that waits on the plugin. */
  trigger(pluginId: string, name: string): PluginJobTriggerResult {
    const job = this.declaredJob(pluginId, name);
    if (!job) return { ok: false, reason: 'unknown-job' };
    if (!job.triggerable) return { ok: false, reason: 'not-triggerable' };
    if (this.inFlight.has(cronKey(pluginId, name))) return { ok: false, reason: 'already-running' };
    void this.run(pluginId, name);
    return { ok: true };
  }

  /** Skips, rather than awaits, a plugin that isn't ready — a leaked hang here would back up every
   *  future tick of this same cron. One run at a time per job: a tick and a trigger share the guard. */
  private async run(pluginId: string, name: string): Promise<void> {
    const key = cronKey(pluginId, name);
    if (this.inFlight.has(key)) {
      this.logger.warn(`skipping job "${name}" for plugin "${pluginId}" — previous run still in flight`);
      return;
    }
    this.inFlight.add(key);
    try {
      if (this.processService.stateOf(pluginId) !== 'ready') {
        this.logger.warn(`skipping job "${name}" for plugin "${pluginId}" — process is not ready`);
        return;
      }
      await this.processService.callPlugin(pluginId, 'job', { name, jobId: randomUUID() }, JOB_CALL_DEADLINE_MS);
      this.logger.log(`job "${name}" for plugin "${pluginId}" completed`);
    } catch (err) {
      this.logger.warn(`job "${name}" for plugin "${pluginId}" failed: ${(err as Error).message}`);
    } finally {
      this.inFlight.delete(key);
    }
  }
}
