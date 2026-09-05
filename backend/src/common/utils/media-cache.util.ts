import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Per-media on-disk cache convention.
 *
 * `.cache/` at a media root is only ever removed, never written: a library can
 * be mounted read-only or moved without the app, so cached artefacts live in the
 * managed images volume instead.
 */

/** Absolute path to the `.cache/` directory at the media root. */
export function getMediaCacheDir(mediaRoot: string): string {
  return path.join(mediaRoot, '.cache');
}

/**
 * Wipe the entire per-media `.cache/` directory — not just a single feature's
 * subtree. Called on a full rescan since any cached artefact (subtitles,
 * sprites, future features...) is potentially stale when the source files
 * are being re-read.
 */
export async function clearMediaCache(
  mediaRoot: string | null | undefined,
): Promise<void> {
  if (!mediaRoot) return;
  const cacheDir = getMediaCacheDir(mediaRoot);
  await fs.rm(cacheDir, { recursive: true, force: true });
}
