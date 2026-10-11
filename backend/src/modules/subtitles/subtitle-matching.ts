import * as path from 'path';

/**
 * Which video of a media a sidecar subtitle belongs to: longest dot-prefix of its name matching a
 * video basename, else the single-video fallback. Shared by discovery and the companion listing.
 */
export function matchSubtitleVideo<T extends { relativePath: string }>(
  entry: string,
  dir: string,
  files: T[],
  mediaPath: string,
  hasOwnFolder: boolean,
): T | null {
  const byBase = new Map<string, T>();
  for (const f of files) {
    byBase.set(path.basename(f.relativePath, path.extname(f.relativePath)).toLowerCase(), f);
  }
  const ext = path.extname(entry).toLowerCase();
  const parts = path.basename(entry, ext).toLowerCase().split('.');
  for (let len = parts.length - 1; len >= 1; len--) {
    const hit = byBase.get(parts.slice(0, len).join('.'));
    if (hit) return hit;
  }
  // A media without a folder shares its root with sibling movies: no lone-video guess there.
  if (!hasOwnFolder) return null;
  const inDir = files.filter((f) => path.dirname(path.join(mediaPath, f.relativePath)) === dir);
  if (inDir.length === 1) return inDir[0];
  if (!inDir.length && files.length === 1) return files[0];
  return null;
}
