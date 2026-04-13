import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Per-media on-disk cache convention.
 *
 * `.cache/` lives at the root of every media folder and is shared between
 * features:
 *   - `.cache/subs/<mediaFileId>/emb-<streamIndex>.vtt`  (SubtitleStreamService)
 *   - future: `.cache/sprite/...`, `.cache/trickplay/...`, etc.
 *
 * The whole `.cache/` tree is disposable — it's wiped on a full rescan
 * (`clearMediaCache`) and recreated on demand. Any new feature that wants
 * cheap persistence across restarts should land here.
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
