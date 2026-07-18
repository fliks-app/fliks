import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';
import { statSync } from 'fs';

const execFileAsync = promisify(execFile);
const log = new Logger('SegmentBoundaries');

/**
 * Keyframe-accurate HLS segment grid for the REMUX / copy-video path.
 *
 * Transcoded video forces an IDR every `segmentDuration`s (`-force_key_frames`),
 * so its segments — and the served playlist — sit on a uniform grid. Copied
 * video can't force keyframes: ffmpeg's HLS muxer cuts at the source keyframes,
 * producing wildly variable segment lengths (seen 1–15s on a Blu-ray HEVC rip).
 * Serving a uniform `EXTINF` for those segments makes strict players (AVPlayer)
 * drift progressively out of A/V sync — they trust `EXTINF` for the timeline,
 * unlike Shaka/ExoPlayer which re-anchor on each fragment's `tfdt`.
 *
 * We mirror ffmpeg's copy segmentation by reading the source keyframes and
 * cutting at the first keyframe at/after a target that advances by
 * `segmentDuration` per cut. This reproduces ffmpeg's actual `index.m3u8`
 * boundaries to within a few milliseconds.
 */

/** Real per-segment content durations (for the playlist EXTINF) plus the
 *  absolute cut times in source PTS (for resume seeking). Kept together because
 *  both come from one keyframe walk and a source whose first PTS is non-zero
 *  (TS / PVR rips) must declare content-relative durations while still seeking
 *  to the absolute keyframe. */
export interface SegmentGrid {
  durations: number[];
  boundaries: number[];
}

interface CacheEntry {
  mtimeMs: number;
  segDur: number;
  grid: SegmentGrid;
}

const cache = new Map<string, CacheEntry>();

/** Video keyframe presentation times (seconds, ascending) of the source. */
export async function extractKeyframeTimes(filePath: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      filePath,
    ],
    { maxBuffer: 128 * 1024 * 1024, timeout: 120_000 },
  );
  return stdout
    .split('\n')
    .map((line) => parseFloat(line))
    .filter((t) => Number.isFinite(t) && t >= 0)
    .sort((a, b) => a - b);
}

/**
 * Per-segment durations (seconds) ffmpeg's HLS muxer produces when copying a
 * keyframe-cut video. Cut at the first keyframe ≥ a target that advances by
 * `segDur` after each cut; the tail runs to `totalDuration`. Matches Jellyfin's
 * `ComputeSegments` and our ffmpeg's real output (verified to within ~7ms).
 */
export function computeSegmentDurations(
  keyframeTimes: number[],
  totalDuration: number,
  segDur: number,
): number[] {
  if (keyframeTimes.length === 0 || segDur <= 0) return [];
  // A keyframe past the container-reported duration extends the timeline so the
  // tail segment isn't negative (Jellyfin #16703).
  const last = keyframeTimes[keyframeTimes.length - 1];
  const total = Math.max(totalDuration, last);
  if (total <= 0) return [];

  // Anchor at the first keyframe: ffmpeg measures each segment's elapsed time
  // from its own first packet, so on a source with start PTS > 0 (TS / PVR
  // rips) cuts advance from `start`, not 0, and the first segment's real
  // duration is `firstCut - start`. For start === 0 this is unchanged.
  const start = keyframeTimes[0];
  const durations: number[] = [];
  let lastCut = start;
  let target = start + segDur;
  for (const kf of keyframeTimes) {
    if (kf >= target) {
      durations.push(kf - lastCut);
      lastCut = kf;
      target += segDur;
    }
  }
  const remaining = total - lastCut;
  if (remaining > 0.001) durations.push(remaining);
  return durations;
}

/** Cumulative segment start times from `start`; `boundaries[i]` is the start of
 *  seg-`i`, the last entry is the total end. `start` is the source's first PTS
 *  (0 for MP4/MKV) so the boundaries stay in absolute source time for seeking. */
export function boundariesFromDurations(
  durations: number[],
  start = 0,
): number[] {
  const boundaries = [start];
  for (const d of durations) {
    boundaries.push(boundaries[boundaries.length - 1] + d);
  }
  return boundaries;
}

/** Segment index whose `[start, end)` window contains `seconds`. */
export function secondsToSegmentIndex(
  boundaries: number[],
  seconds: number,
): number {
  if (seconds <= 0 || boundaries.length < 2) return 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (seconds < boundaries[i + 1]) return i;
  }
  return boundaries.length - 2;
}

/**
 * Resolve (and cache) the keyframe-aligned segment grid for a source: real
 * per-segment durations (playlist EXTINF) and absolute cut times (seeking).
 * Returns null when keyframes can't be read — the caller then falls back to the
 * uniform grid (no regression). Cache is keyed by path + mtime + segment length.
 */
export async function getRemuxSegmentGrid(
  filePath: string,
  totalDuration: number,
  segDur: number,
): Promise<SegmentGrid | null> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.segDur === segDur) {
    return hit.grid;
  }
  try {
    const keyframes = await extractKeyframeTimes(filePath);
    const durations = computeSegmentDurations(keyframes, totalDuration, segDur);
    if (durations.length === 0) return null;
    const grid: SegmentGrid = {
      durations,
      boundaries: boundariesFromDurations(durations, keyframes[0]),
    };
    cache.set(filePath, { mtimeMs, segDur, grid });
    return grid;
  } catch (err) {
    log.warn(
      `Keyframe probe failed for ${filePath}; falling back to uniform grid: ${(err as Error).message}`,
    );
    return null;
  }
}
