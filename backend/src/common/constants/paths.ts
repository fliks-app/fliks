import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { resolveWritableDir } from './writable-dir';

/** Base directory for transient transcode/thumbnail data.
 *  `FLIKS_TRANSCODE_DIR` overrides; Windows falls back to `%TEMP%`, other
 *  platforms to `/tmp/transcode`. */
const transcodeDirOverride = process.env.FLIKS_TRANSCODE_DIR?.trim();
export const TRANSCODE_DIR =
  transcodeDirOverride && transcodeDirOverride.length > 0
    ? transcodeDirOverride
    : process.platform === 'win32'
      ? path.join(os.tmpdir(), 'fliks-transcode')
      : '/tmp/transcode';

let cachedDataDir: string | null = null;

/** Picked before the write probe so a legacy mount is honoured rather than
 *  shadowed by an empty default. */
function intendedDataDir(): string {
  const override = process.env.FLIKS_DATA_DIR?.trim();
  if (override) return override;
  const legacyOverride = process.env.FLIKS_IMAGES_DIR?.trim();
  if (legacyOverride) {
    new Logger('DataDir').warn(
      'FLIKS_IMAGES_DIR is deprecated — rename it to FLIKS_DATA_DIR (same value)',
    );
    return legacyOverride;
  }
  // The image no longer creates `images/`, so its presence means a volume is
  // still mounted there: keep writing to it instead of starting an empty tree.
  const legacyDir = path.join(process.cwd(), 'images');
  if (existsSync(legacyDir)) {
    new Logger('DataDir').warn(
      `Using the legacy data directory "${legacyDir}" — remount it at ` +
        `"${path.join(process.cwd(), 'data')}" (or set FLIKS_DATA_DIR) when convenient`,
    );
    return legacyDir;
  }
  return path.join(process.cwd(), 'data');
}

/**
 * Artwork and uploaded user avatars. `FLIKS_DATA_DIR` overrides; falls back to
 * a temp dir (wiped on restart) if it isn't writable at the container's uid.
 * Probed once, on first call. Not a cache: the avatars in here cannot be
 * re-fetched.
 */
export function getDataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  cachedDataDir = resolveWritableDir(
    [intendedDataDir(), path.join(os.tmpdir(), 'fliks-data')],
    'Cannot write to the data directory — artwork and uploaded ' +
      'avatars will not survive a restart. Set FLIKS_DATA_DIR, or mount ' +
      '/app/data writable for this container user.',
  );
  return cachedDataDir;
}

let cachedCacheDir: string | null = null;

/**
 * Extracted-subtitle VTTs and seek-preview sprites. Everything here is
 * regenerable and safe to delete. `FLIKS_CACHE_DIR` overrides; otherwise
 * `<dataDir>/cache`. Probed once, on first call.
 */
export function getCacheDir(): string {
  if (cachedCacheDir) return cachedCacheDir;
  const override = process.env.FLIKS_CACHE_DIR?.trim();
  const preferred = override || path.join(getDataDir(), 'cache');
  cachedCacheDir = resolveWritableDir(
    [preferred, path.join(os.tmpdir(), 'fliks-cache')],
    'Cannot write to the cache directory, extracted subtitles and ' +
      'seek-preview sprites will be regenerated on every restart. Set ' +
      'FLIKS_CACHE_DIR to a writable path.',
  );
  return cachedCacheDir;
}

let cachedPluginsRuntimeDir: string | null = null;

/**
 * Base directory for staged and installed plugin files. `FLIKS_RUNTIME_DIR`
 * overrides; falls back to a temp dir (wiped on restart) — durable state
 * lives in `plugin_packages.archive`, not here. Resolved and probed once.
 */
export function getPluginsRuntimeDir(): string {
  if (cachedPluginsRuntimeDir) return cachedPluginsRuntimeDir;
  const override = process.env.FLIKS_RUNTIME_DIR?.trim();
  const preferred = override ? path.join(override, 'fliks-plugins') : path.join(os.tmpdir(), 'fliks-plugins');
  cachedPluginsRuntimeDir = resolveWritableDir(
    [preferred, path.join(os.tmpdir(), 'fliks-plugins')],
    'Cannot write to the plugins runtime directory — installed plugin files ' +
      'will not survive a restart. Set FLIKS_RUNTIME_DIR to a writable path.',
  );
  return cachedPluginsRuntimeDir;
}

/**
 * Sockets and pid files, kept out of the directory that holds plugin content so
 * a sweep of installed files can never touch a live channel. `fliks-rt` is the
 * name the plugin plan gives it.
 */
export function getPluginsSocketDir(): string {
  return path.join(getPluginsRuntimeDir(), 'fliks-rt');
}
