export type StalledCleanupProfileKey = 'fast' | 'medium' | 'slow';

export const STALLED_CLEANUP_PROFILE_KEYS: StalledCleanupProfileKey[] = [
  'fast',
  'medium',
  'slow',
];

export interface StalledCleanupProfileDefaults {
  samples: number;
  intervalMinutes: number;
  autoRestart: boolean;
}

/**
 * Default configuration for each cleanup profile.
 * Detection time = (samples - 1) × intervalMinutes.
 *   fast   — 4 samples × 20 min  → detect after 60 min
 *   medium — 4 samples × 60 min  → detect after 3 h
 *   slow   — 4 samples × 180 min → detect after 9 h
 *
 * These values are seeded into the `cleanup_profiles` table on startup
 * and can be edited by the user through the settings UI.
 */
export const STALLED_CLEANUP_PROFILE_DEFAULTS: Record<
  StalledCleanupProfileKey,
  StalledCleanupProfileDefaults
> = {
  fast: { samples: 4, intervalMinutes: 20, autoRestart: true },
  medium: { samples: 4, intervalMinutes: 60, autoRestart: true },
  slow: { samples: 4, intervalMinutes: 180, autoRestart: true },
};
