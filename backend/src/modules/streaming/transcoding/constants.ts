export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30min HLS session timeout
export const MAX_SESSIONS = 4;
/** Max gap (in segments) between FFmpeg frontier and requested segment before restarting. */
export const SEEK_WAIT_THRESHOLD = 15;

/** Mutable runtime state for HLS segment duration. Updated from admin
 *  streaming settings via `setSegmentDuration()`. Read by FFmpeg arg
 *  builders and the session manager. */
let segmentDuration = 3;

export function getSegmentDuration(): number {
  return segmentDuration;
}

export function setSegmentDuration(seg: number): void {
  segmentDuration = seg;
}

/** Convert a presentation time (seconds) to the FFmpeg segment number
 *  that contains it. Uniform grid: every segment is `segmentDuration`
 *  long, seg-N covers `[N*SEG, (N+1)*SEG)`. */
export function secondsToSegmentIndex(seconds: number): number {
  if (seconds <= 0) return 0;
  return Math.floor(seconds / segmentDuration);
}

/** Inverse of `secondsToSegmentIndex` — start time of an FFmpeg segment. */
export function segmentIndexToSeconds(segment: number): number {
  if (segment <= 0) return 0;
  return segment * segmentDuration;
}
