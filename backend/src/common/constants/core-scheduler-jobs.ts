/**
 * Every core cron job's bare name, mirrored from `SchedulerService.SCHEDULERS`. Restated here
 * (rather than imported) so `PluginRegistryService` can refuse a plugin job name that collides
 * with one without `modules/plugins` importing the scheduler module back.
 *
 * `scheduler.service.ts` types `SCHEDULERS[number].name` against this same array, so adding a
 * core job there without adding its name here fails to typecheck.
 */
export const CORE_SCHEDULER_JOB_NAMES = [
  'SearchMissing',
  'RefreshMetadata',
  'RssSync',
  'ImportCompleted',
  'CleanStalled',
  'CleanSeeded',
  'SubtitleSearch',
  'SubtitleUpgrade',
] as const;

export type CoreSchedulerJobName = (typeof CORE_SCHEDULER_JOB_NAMES)[number];
