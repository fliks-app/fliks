/** A position read at `at` (ms on the server clock): where a playing item stands is extrapolated from it. */
export interface PositionAnchor {
  position: number;
  at: number;
  playing: boolean;
  duration: number | null;
}

/** The one extrapolation of a remote playback's position, whatever the anchor came from. */
export function projectPosition(a: PositionAnchor, nowMs: number): number {
  if (!a.playing) return a.position;
  const projected = a.position + Math.max(0, nowMs - a.at) / 1000;
  return a.duration ? Math.min(projected, a.duration) : projected;
}
