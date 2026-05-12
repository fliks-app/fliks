export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30min HLS session timeout
export const MAX_SESSIONS = 4;
/** Max gap (in segments) between FFmpeg frontier and requested segment before restarting. */
export const SEEK_WAIT_THRESHOLD = 15;

/** Mutable runtime state for HLS segment durations. Updated from admin
 *  streaming settings via `setSegmentDurations()`. Read by FFmpeg arg
 *  builders and the session manager. */
let segmentDuration = 3;
let initTime = 1;

export function getSegmentDuration(): number {
  return segmentDuration;
}

export function getInitTime(): number {
  return initTime;
}

export function setSegmentDurations(seg: number, init: number): void {
  segmentDuration = seg;
  initTime = init;
}

/** True when `-hls_init_time` actually shortens segment 0 (FFmpeg ignores it
 *  when init >= segment duration). */
export function useShortInitSegment(
  init = initTime,
  seg = segmentDuration,
): boolean {
  return init > 0 && init < seg;
}

/** Convert a presentation time (seconds) to the FFmpeg segment number that
 *  contains it. Mirrors `-hls_init_time`: seg-0 holds [0, INIT_TIME],
 *  seg-N>=1 holds [INIT_TIME + (N-1)*SEG, INIT_TIME + N*SEG]. */
export function secondsToSegmentIndex(seconds: number): number {
  if (seconds <= 0) return 0;
  if (!useShortInitSegment()) {
    return Math.floor(seconds / segmentDuration);
  }
  if (seconds < initTime) return 0;
  return 1 + Math.floor((seconds - initTime) / segmentDuration);
}

/** Inverse of `secondsToSegmentIndex` — start time of an FFmpeg segment. */
export function segmentIndexToSeconds(segment: number): number {
  if (segment <= 0) return 0;
  if (!useShortInitSegment()) return segment * segmentDuration;
  return initTime + (segment - 1) * segmentDuration;
}
