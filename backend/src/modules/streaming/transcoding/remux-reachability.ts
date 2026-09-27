/** Wait-vs-respawn decision for a remux run, as pure functions of its own
 *  measured frontier, never the shared (killed-run-island-prone) directory. */

/** Live run: reachable if already produced, or within `waitWindow` of the
 *  frontier. Null frontier (run not opened) allows only near its own start. */
export function remuxReachable(o: {
  requestedSegment: number;
  start: number;
  frontier: number | null;
  waitWindow: number;
}): boolean {
  if (o.requestedSegment < o.start) return false;
  if (o.frontier == null) return o.requestedSegment - o.start <= o.waitWindow;
  return o.requestedSegment <= o.frontier + o.waitWindow;
}

/** Exited run: the frontier is a hard boundary, no buffer-ahead allowance. */
export function remuxProduced(o: {
  requestedSegment: number;
  start: number;
  frontier: number | null;
}): boolean {
  return o.frontier != null && o.requestedSegment >= o.start && o.requestedSegment < o.frontier;
}

/** Segments of slack past the frontier, sized to measured throughput and
 *  capped low so a stalled or slow run still respawns quickly. */
export function remuxWaitWindow(o: {
  segmentsPerSecond: number | null;
  bufferSeconds: number;
  capSegments: number;
}): number {
  if (o.segmentsPerSecond == null) return o.capSegments;
  return Math.min(
    o.capSegments,
    Math.max(1, Math.round(o.segmentsPerSecond * o.bufferSeconds)),
  );
}
