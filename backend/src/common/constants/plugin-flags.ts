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

/** The only way a `process` plugin may ship unsigned — for local development against the production signing key. */
export const FLIKS_UNSIGNED_PLUGINS_ENV = 'FLIKS_UNSIGNED_PLUGINS';

/** Comma-separated `FLIKS_UNSIGNED_PLUGINS` ids, trimmed, empties dropped. */
export function unsignedProcessAllowlist(): string[] {
  return (process.env[FLIKS_UNSIGNED_PLUGINS_ENV] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
