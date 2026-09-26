import { Logger } from '@nestjs/common';
import { stat } from 'fs/promises';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import {
  sourceIsMpegTs,
  videoPackets,
  type Keyframe,
} from '../../subtitles/video-packets';
import { sourceTimeline } from './source-timeline';
import { frameSecondsOf, parseSourceFps } from './constants';

const log = new Logger('SegmentBoundaries');

// Copied video cuts only at its own irregular keyframes, so the remux playlist
// declares each segment's real length: AVPlayer drifts on a uniform EXTINF grid.

/** How far under its first keyframe's decode time the run from the file start
 *  seeks: well under a frame, far above the microsecond a derived decode time
 *  can be off by. */
export const DECODE_TIME_TOLERANCE_SECONDS = 0.01;

export type { Keyframe };

/** The keyframe segment grid of the remux / copy-video path. */
export interface KeyframeGrid {
  /** Presented length of each segment (the playlist EXTINF). */
  durations: number[];
  /** Source time each segment's presentation starts at (the first one at the
   *  timeline origin), then the source end. */
  boundaries: number[];
  /** Video keyframes in decode order. */
  keyframes: Keyframe[];
  /** Index in `keyframes` of each segment's first keyframe, then their count. */
  firstKeyframe: number[];
}

/** The MPEG-TS demuxer seeks to a byte position and decoding picks up at the
 *  next keyframe, so a seek lands up to a GOP after its target; the others
 *  land on the keyframe at or before it. */
export function seeksPastKeyframe(
  si: Pick<MediaFileInfo, 'formatName'> | null | undefined,
  filePath: string,
): boolean {
  return sourceIsMpegTs(si, filePath);
}

/**
 * Group the keyframes into segments of about `segDur`: a segment ends at the
 * first keyframe at or past a target advancing `segDur` per cut from the
 * first; the tail runs to `end`, and a keyframe starting no whole frame
 * before it stays in the last segment. The grid starts on the first keyframe shown
 * at or after `origin`: an edit list starting mid-GOP hides pre-roll a copy
 * could only decode before the timeline start.
 */
export function computeSegmentGrid(
  allKeyframes: Keyframe[],
  origin: number,
  end: number,
  segDur: number,
  frameSeconds = frameSecondsOf(undefined),
): KeyframeGrid | null {
  // Under half a frame apart, two times are the same frame's.
  const sameFrame = frameSeconds / 2;
  const keyframes = allKeyframes.filter((k) => k.pts >= origin - sameFrame);
  if (keyframes.length === 0 || segDur <= 0) return null;
  const last = keyframes[keyframes.length - 1].pts;
  const total = Math.max(end, last);
  const start = Math.max(origin, keyframes[0].pts);
  const boundaries = [start];
  const firstKeyframe = [0];
  let target = start + segDur;
  keyframes.forEach((kf, i) => {
    if (i === 0 || kf.pts < target || total - kf.pts < sameFrame) return;
    boundaries.push(kf.pts);
    firstKeyframe.push(i);
    target += segDur;
  });
  boundaries.push(total);
  firstKeyframe.push(keyframes.length);
  const durations = boundaries.slice(1).map((b, i) => b - boundaries[i]);
  return { durations, boundaries, keyframes, firstKeyframe };
}

/** Segment of the keyframe grid whose `[start, end)` window holds content
 *  position `seconds` (from the first frame, hence the `origin`). */
export function gridSegmentIndex(
  boundaries: number[],
  seconds: number,
  origin: number,
): number {
  if (seconds <= 0 || boundaries.length < 2) return 0;
  const at = seconds + origin;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (at < boundaries[i + 1]) return i;
  }
  return boundaries.length - 2;
}

interface GridEntry {
  mtimeMs: number;
  segDur: number;
  grid: Promise<KeyframeGrid | null>;
}

const grids = new Map<string, GridEntry>();
const MAX_GRIDS = 64;

/**
 * The keyframe grid of a source, ending where its video ends, or null when
 * its keyframes can't be read: the remux then runs on the uniform grid. One
 * answer per file version, the failure included, so every request of a
 * playback agrees on it; concurrent requests share one read.
 */
export async function getRemuxSegmentGrid(
  filePath: string,
  segDur: number,
  streamInfo: Pick<MediaFileInfo, 'video' | 'formatStartSeconds' | 'formatName'> | null | undefined,
): Promise<KeyframeGrid | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch (err) {
    log.warn(`Cannot stat ${filePath}; uniform grid: ${(err as Error).message}`);
    return null;
  }
  const hit = grids.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.segDur === segDur) return hit.grid;
  const v = streamInfo?.video?.[0];
  const grid = videoPackets(
    filePath,
    { streamIndex: v?.streamIndex, reorderFrames: v?.reorderFrames, avgFrameRate: v?.avgFrameRate },
    { mpegTs: sourceIsMpegTs(streamInfo, filePath) },
  ).then(
    ({ keyframes, end }) => {
      const { origin } = sourceTimeline(streamInfo, filePath);
      const frame = frameSecondsOf(parseSourceFps(v?.frameRate));
      const g = computeSegmentGrid(keyframes, origin, end, segDur, frame);
      if (!g) log.warn(`No video keyframe in ${filePath}; uniform grid`);
      return g;
    },
    (err: Error) => {
      log.warn(`Keyframe probe failed for ${filePath}; uniform grid: ${err.message}`);
      return null;
    },
  );
  grids.delete(filePath);
  grids.set(filePath, { mtimeMs, segDur, grid });
  if (grids.size > MAX_GRIDS) grids.delete(grids.keys().next().value!);
  return grid;
}
