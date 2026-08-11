/** Duck-typed rather than importing `SettingsService` — keeps this file inside
 *  the plugins/download/ → core import fence (see eslint.config.mjs). */
interface SettingsReader {
  get(key: string): Promise<string | null>;
}

export const STALL_SAMPLES_KEY = 'plugin.download.stall_samples';
export const STALL_INTERVAL_MINUTES_KEY =
  'plugin.download.stall_interval_minutes';
export const STALL_AUTO_RESTART_KEY = 'plugin.download.stall_auto_restart';
export const STALL_INCLUDE_MANUAL_GRABS_KEY =
  'plugin.download.stall_include_manual_grabs';

export interface StallConfig {
  samples: number;
  intervalMinutes: number;
  autoRestart: boolean;
  includeManualGrabs: boolean;
}

/** `null` means cleanup stays off. Samples unset (every fresh install) must
 *  never fall back to a default that starts deleting torrents. */
export async function getStallConfig(
  settings: SettingsReader,
): Promise<StallConfig | null> {
  const samples = parseInt((await settings.get(STALL_SAMPLES_KEY)) ?? '', 10);
  if (!Number.isFinite(samples) || samples < 2) return null;

  const intervalMinutes = parseInt(
    (await settings.get(STALL_INTERVAL_MINUTES_KEY)) ?? '',
    10,
  );
  return {
    samples,
    intervalMinutes:
      Number.isFinite(intervalMinutes) && intervalMinutes > 0
        ? intervalMinutes
        : 60,
    autoRestart: (await settings.get(STALL_AUTO_RESTART_KEY)) === 'true',
    includeManualGrabs:
      (await settings.get(STALL_INCLUDE_MANUAL_GRABS_KEY)) === 'true',
  };
}
