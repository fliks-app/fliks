import { StreamLifetime } from '../lifetime-constants';

/** Maximum idle window for transcode sessions that were never paired
 *  with a {@link LiveSessionRegistry} entry (legacy URL fetches, admin
 *  scrubbing, etc.). Sessions tied to a live session ride on the
 *  {@link JOB_GRACE_MS} grace window after their last heartbeat
 *  instead — see `TranscodingService.cleanupStaleSessions`. Sourced
 *  from `STREAM_JOB_FALLBACK_TIMEOUT_MS` — see lifetime-constants.ts. */
export const SESSION_TIMEOUT_MS = StreamLifetime.jobFallbackTimeoutMs();

/** Grace window between the last matching live session disappearing and
 *  the ffmpeg job being killed. Keeps a brief reconnect window so a
 *  client that misses a few heartbeats (background tab, lockscreen)
 *  can reattach without restarting the encoder. The cache directory
 *  is preserved across the kill — a fresh play picks up from the
 *  existing segments. Sourced from `STREAM_JOB_GRACE_MS` — see
 *  lifetime-constants.ts. */
export const JOB_GRACE_MS = StreamLifetime.jobGraceMs();

/** Max gap (in segments) between FFmpeg frontier and requested segment before restarting. */
export const SEEK_WAIT_THRESHOLD = 15;

/** Number of leading segments (seg-0 .. seg-(N-1)) the early-start companion
 *  pre-encodes at position 0 while the main session spins up at the resume
 *  point. Drives BOTH how long the early ffmpeg reads (its `-t`) and how many
 *  segment requests route to it — the two must agree, or a resume probe hits a
 *  session that never wrote that segment. Independent of segment duration. */
export const EARLY_PROBE_SEGMENTS = 2;

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

/** Real length of one transcoded segment = a pinned GOP of
 *  `round(segmentDuration · fps)` frames = `gop / fps` seconds. Equals
 *  `segmentDuration` for integer / unknown fps; differs only for fractional
 *  rates (24000/1001 → 3.003s at a 3s setting). */
export function realSegmentSeconds(fps?: number): number {
  if (!fps || fps <= 0) return segmentDuration;
  return Math.max(1, Math.round(segmentDuration * fps)) / fps;
}

/** Presentation time (seconds) → containing FFmpeg segment number, on the
 *  `fps`-aware real-duration grid. */
export function secondsToSegmentIndex(seconds: number, fps?: number): number {
  if (seconds <= 0) return 0;
  return Math.floor(seconds / realSegmentSeconds(fps));
}

/** Inverse of `secondsToSegmentIndex` — start time of an FFmpeg segment. */
export function segmentIndexToSeconds(segment: number, fps?: number): number {
  if (segment <= 0) return 0;
  return segment * realSegmentSeconds(fps);
}
