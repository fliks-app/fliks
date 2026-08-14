/**
 * Every core cron job's bare name, mirrored from `SchedulerService.SCHEDULERS`. Restated here
 * (rather than imported) so `PluginRegistryService` can refuse a plugin job name that collides
 * with one without `modules/plugins` importing the scheduler module back. A bundle's own job
 * names are its own business — they publish through `ScheduledJobRegistry` instead, which
 * checks itself against this same list.
 *
 * `scheduler.service.ts` types `SCHEDULERS[number].name` against this same array, so adding a
 * core job there without adding its name here fails to typecheck.
 */
export const CORE_SCHEDULER_JOB_NAMES = [
  'RefreshMetadata',
  'SubtitleSearch',
  'SubtitleUpgrade',
] as const;

export type CoreSchedulerJobName = (typeof CORE_SCHEDULER_JOB_NAMES)[number];

/**
 * Core commands that have no cron but are triggerable by name from `POST /commands`. A plugin job
 * sharing one of these names would never be reachable: the command dispatcher answers first.
 */
export const CORE_TRIGGER_ONLY_JOB_NAMES = [
  'RescanAll',
  'RefreshMissingMetadata',
  'RescanMissingFiles',
  'GenerateSprites',
  'GenerateMissingSprites',
  'DetectMarkers',
  'DetectMissingMarkers',
] as const;

/** Every name a plugin job may not take, whether cron-driven or trigger-only. */
export const RESERVED_CORE_JOB_NAMES: readonly string[] = [
  ...CORE_SCHEDULER_JOB_NAMES,
  ...CORE_TRIGGER_ONLY_JOB_NAMES,
];
