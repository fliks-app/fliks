export const SESSION_TIMEOUT_MS = 60 * 1000; // 60s (like Jellyfin HLS timeout)
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
