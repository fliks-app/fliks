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

/** Default HLS segment duration (seconds) when the admin setting is
 *  unavailable. The live value is an admin streaming setting held by
 *  `ActiveStreamTracker`, frozen onto each session at spawn (`sourceFps`'s
 *  sibling), and threaded explicitly into the grid helpers below — never a
 *  module-mutable global, so a mid-playback setting change can't re-grid a
 *  session against the segments already cut on its old grid. */
export const DEFAULT_SEGMENT_DURATION = 3;

/** Real length of one transcoded segment: a pinned GOP of
 *  `round(segmentDuration · fps)` frames (`gop / fps` seconds), snapped to the
 *  millisecond. Equals `segmentDuration` for integer / unknown fps; a
 *  fractional rate yields the true whole-ms GOP length (24000/1001 → 3.003s).
 *
 *  The ms snap is load-bearing. `fps` arrives rounded to 3 decimals
 *  (`parseFrameRate` stores 24000/1001 as "23.976"), so raw `gop / fps` sits a
 *  sub-ms sliver ABOVE the true GOP (72/23.976 = 3.0030030… vs the true
 *  72·1001/24000 = 3.003). This value is `-hls_time`: FFmpeg's HLS muxer cuts
 *  on the first keyframe once the threshold has elapsed, so a threshold above
 *  one GOP skips the per-segment forced IDR and packs two GOPs into the run's
 *  first segment. Snapping to the ms the real frame rate lands on keeps
 *  `-hls_time` at/below one GOP, so the muxer cuts on every IDR. */
export function realSegmentSeconds(
  segmentDuration: number,
  fps?: number,
): number {
  if (!fps || fps <= 0) return segmentDuration;
  const gopSeconds = Math.max(1, Math.round(segmentDuration * fps)) / fps;
  return Math.round(gopSeconds * 1000) / 1000;
}

/** Parse a ffprobe `frameRate` to fps, or `undefined` when unknown. Accepts a
 *  decimal ("23.976") or a rational ("24000/1001"): ffprobe reports
 *  `r_frame_rate` as a rational, and a bare `parseFloat("24000/1001")` yields
 *  24000, which would blow up the GOP and segment grid. Single rule for the
 *  transcode/playlist callers that feed {@link realSegmentSeconds} — a divergent
 *  parse would declare a different segment length for one surface and
 *  reintroduce fractional-fps A/V drift. */
export function parseSourceFps(frameRate: string | undefined): number | undefined {
  if (!frameRate) return undefined;
  const slash = frameRate.indexOf('/');
  if (slash !== -1) {
    const num = Number(frameRate.slice(0, slash));
    const den = Number(frameRate.slice(slash + 1));
    return num > 0 && den > 0 ? num / den : undefined;
  }
  return parseFloat(frameRate) || undefined;
}

/** Presentation time (seconds) → containing FFmpeg segment number, on the
 *  `fps`-aware real-duration grid. */
export function secondsToSegmentIndex(
  seconds: number,
  segmentDuration: number,
  fps?: number,
): number {
  if (seconds <= 0) return 0;
  return Math.floor(seconds / realSegmentSeconds(segmentDuration, fps));
}

/** Inverse of `secondsToSegmentIndex` — start time of an FFmpeg segment. */
export function segmentIndexToSeconds(
  segment: number,
  segmentDuration: number,
  fps?: number,
): number {
  if (segment <= 0) return 0;
  return segment * realSegmentSeconds(segmentDuration, fps);
}
