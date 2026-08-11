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

/** Which in-repo bundles (`src/plugins/<id>/`) load into the module graph. */
export const FLIKS_BUNDLES_ENV = 'FLIKS_BUNDLES';

/** The bundle backing acquisition (indexers, download clients, grab, the acquisition jobs). */
const DOWNLOAD_BUNDLE_ID = 'download';

/**
 * True when `bundleId` is in the comma-separated `FLIKS_BUNDLES` allowlist. Unset loads every
 * bundle (today's behaviour); an empty string loads none; an id absent from a non-empty list
 * is off. Unrecognised ids are ignored, same as `FLIKS_UNSIGNED_PLUGINS`.
 */
export function isBundleEnabled(bundleId: string): boolean {
  const raw = process.env[FLIKS_BUNDLES_ENV];
  if (raw === undefined) return true;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .includes(bundleId);
}

export function isDownloadBundleEnabled(): boolean {
  return isBundleEnabled(DOWNLOAD_BUNDLE_ID);
}
