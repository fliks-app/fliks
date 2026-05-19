import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Check if a segment (or its predecessor) exists. Checks .m4s, .ts, root, and subdir 0/. */
export async function segmentNearby(
  cachePath: string,
  segment: number,
): Promise<boolean> {
  const num = String(segment).padStart(4, '0');
  const prevNum = segment > 0 ? String(segment - 1).padStart(4, '0') : null;
  const exts = ['.m4s', '.ts'];
  const dirs = [cachePath, path.join(cachePath, '0')];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await fileExists(path.join(dir, `seg-${num}${ext}`))) return true;
      if (prevNum && (await fileExists(path.join(dir, `seg-${prevNum}${ext}`))))
        return true;
    }
  }
  return false;
}

/**
 * Starting from `fromSegment`, find the first segment number NOT on disk.
 * Returns `null` when every segment up to a reasonable lookahead exists.
 */
export function firstMissingSegment(
  cachePath: string,
  fromSegment: number,
  maxLookahead = 2000,
): number | null {
  const exts = ['.m4s', '.ts'];
  const dirs = [cachePath, path.join(cachePath, '0')];
  for (let seg = fromSegment; seg < fromSegment + maxLookahead; seg++) {
    const num = String(seg).padStart(4, '0');
    let found = false;
    for (const dir of dirs) {
      if (found) break;
      for (const ext of exts) {
        if (existsSync(path.join(dir, `seg-${num}${ext}`))) {
          found = true;
          break;
        }
      }
    }
    if (!found) return seg;
  }
  return null;
}
