/**
 * Crash-loop rescue lever (Decision 23 of the plugin-system plan): set
 * before any plugin file I/O runs, so a bad plugin can be locked out
 * without a live HTTP server to click a restart button through.
 */
export const FLIKS_PLUGINS_DISABLED_ENV = 'FLIKS_PLUGINS_DISABLED';

/** True when `FLIKS_PLUGINS_DISABLED=1` is set in the server environment. */
export function arePluginsDisabled(): boolean {
  return process.env[FLIKS_PLUGINS_DISABLED_ENV] === '1';
}
