/** Maximum idle window for transcode sessions that were never paired
 *  with a {@link LiveSessionRegistry} entry (legacy URL fetches, admin
 *  scrubbing, etc.). Sessions tied to a live session ride on the
 *  {@link JOB_GRACE_MS} grace window after their last heartbeat
 *  instead — see `TranscodingService.cleanupStaleSessions`. */
export const SESSION_TIMEOUT_MS = (() => {
  const raw = process.env.STREAM_JOB_FALLBACK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();

/** Grace window between the last matching live session disappearing and
 *  the ffmpeg job being killed. Keeps a brief reconnect window so a
 *  client that misses a few heartbeats (background tab, lockscreen)
 *  can reattach without restarting the encoder. The cache directory
 *  is preserved across the kill — a fresh play picks up from the
 *  existing segments. */
export const JOB_GRACE_MS = (() => {
  const raw = process.env.STREAM_JOB_GRACE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

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
