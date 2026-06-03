/** A stall snapshot reduced to its bytes counter (bigint-as-string). */
export interface ProgressSample {
  downloadedBytes: string;
}

/**
 * qBit raw states eligible for stall detection — states where download
 * progress is expected, so a flat byte counter means the torrent is stuck.
 * Everything else (paused/stopped/queued/checking/allocating/moving and
 * every seeding-side state) makes no progress by design and must never be
 * flagged. `error` and `missingFiles` go through the same stall window as
 * the rest: a transient error (tracker down, disk briefly unmounted) gets
 * the full window to recover before removal.
 */
export const STALL_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  'downloading',
  'forcedDL',
  'stalledDL',
  'metaDL',
  'forcedMetaDL',
  'error',
  'missingFiles',
]);

/**
 * Consecutive-snapshot delta below this counts as "no progress".
 *
 * 1 MiB tolerates the trickle of wasted bytes a stalled torrent keeps
 * receiving from churning peers (re-requested / discarded pieces) without
 * masking a genuinely progressing download: the shortest snapshot interval
 * is 20 minutes, where even a crawling 10 KiB/s nets ~11 MiB per interval.
 */
export const STALL_PROGRESS_TOLERANCE_BYTES = 1n << 20n; // 1 MiB

/**
 * Whether the step from `olderBytes` to `newerBytes` counts as no progress.
 *
 * A negative delta means the client reset its `downloaded` counter (qBit
 * does this on recheck) — treated as progress so the strike run restarts
 * from the reset rather than counting the drop as a flat step.
 */
export function isNoProgress(olderBytes: string, newerBytes: string): boolean {
  const delta = BigInt(newerBytes) - BigInt(olderBytes);
  if (delta < 0n) return false;
  return delta < STALL_PROGRESS_TOLERANCE_BYTES;
}

/**
 * Run-length of trailing snapshots showing no progress, for samples ordered
 * newest-first (DESC by `checkedAt`) — the order both call sites query in.
 *
 * A lone snapshot counts as 1 strike; N flat snapshots count as N. The
 * stalled cleanup fires when the count reaches the profile's `samples`.
 */
export function countStalledStrikes(
  samplesDescByCheckedAt: ProgressSample[],
): number {
  if (!samplesDescByCheckedAt.length) return 0;
  let strikes = 1;
  for (let i = 0; i + 1 < samplesDescByCheckedAt.length; i++) {
    const newer = samplesDescByCheckedAt[i].downloadedBytes;
    const older = samplesDescByCheckedAt[i + 1].downloadedBytes;
    if (!isNoProgress(older, newer)) break;
    strikes++;
  }
  return strikes;
}
