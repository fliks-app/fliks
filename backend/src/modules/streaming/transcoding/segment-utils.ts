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
 * True when a produced segment exists within `lookback` positions at or below
 * `from` — i.e. the encoder frontier is at most `lookback` segments behind the
 * request. Distinguishes a client buffering just ahead of a live encode (wait)
 * from a genuine seek far past the frontier (restart).
 */
export async function segmentWithinReach(
  cachePath: string,
  from: number,
  lookback: number,
): Promise<boolean> {
  const exts = ['.m4s', '.ts'];
  const dirs = [cachePath, path.join(cachePath, '0')];
  const lowest = Math.max(0, from - lookback);
  for (let seg = from; seg >= lowest; seg--) {
    const num = String(seg).padStart(4, '0');
    for (const dir of dirs) {
      for (const ext of exts) {
        if (await fileExists(path.join(dir, `seg-${num}${ext}`))) return true;
      }
    }
  }
  return false;
}

/**
 * Delete cached segments numbered `>= fromSegment` across the flat layout and
 * any var_stream_map numeric subdirs (`0/`, `1/`, …). Called when a run
 * (re)starts at a new seek point: each run's segments carry a tfdt that is
 * 0-based at its own `-ss`, so leaving a previous run's segments ahead of the
 * new start makes the decode timeline jump backward at the boundary and stalls
 * the player. Purging everything from the new start forward guarantees the
 * play-forward path only ever sees the current run's timeline. `init_*.mp4` is
 * left intact — codec config is identical across runs.
 */
export async function purgeSegmentsFrom(
  cacheDir: string,
  fromSegment: number,
): Promise<void> {
  const segRe = /^seg-(\d+)\.(m4s|ts)$/;
  const dirs = [cacheDir];
  let top: import('fs').Dirent[];
  try {
    top = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of top) {
    if (e.isDirectory() && /^\d+$/.test(e.name)) {
      dirs.push(path.join(cacheDir, e.name));
    }
  }
  await Promise.all(
    dirs.map(async (dir) => {
      let files: string[];
      try {
        files = await fsp.readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        files.map((f) => {
          const m = segRe.exec(f);
          if (m && parseInt(m[1], 10) >= fromSegment) {
            return fsp.unlink(path.join(dir, f)).catch(() => undefined);
          }
          return undefined;
        }),
      );
    }),
  );
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
