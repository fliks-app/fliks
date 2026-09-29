import { type Keyframe } from '../../subtitles/video-packets';
import { frameSecondsOf, parseSourceFps } from './constants';
import type { SourceScan } from './source-scan';

// Copied video cuts only at its own irregular keyframes, so the remux playlist
// declares each segment's real length: AVPlayer drifts on a uniform EXTINF grid.

/** How far under its first keyframe's decode time the run from the start seeks:
 *  under a frame, over the microsecond a derived decode time can be off. */
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

/** Cut at the first keyframe past a target advancing `segDur` per cut, from the
 *  first keyframe shown at `origin` (a copy can't show pre-roll) to `end`. */
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

/** The keyframe grid a remux would keep for `scan`, or null with no scan yet or
 *  no keyframe past `origin`. Frozen once per request so evaluate()'s
 *  AudioEndsEarly check and the grid actually served can never disagree. */
export function remuxSegmentGrid(
  scan: Pick<SourceScan, 'keyframes' | 'end'> | null,
  origin: number,
  segDur: number,
  frameRate: string | undefined,
): KeyframeGrid | null {
  if (!scan) return null;
  return computeSegmentGrid(
    scan.keyframes,
    origin,
    scan.end,
    segDur,
    frameSecondsOf(parseSourceFps(frameRate)),
  );
}
