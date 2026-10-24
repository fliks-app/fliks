import type { PartyAnchor, PartyPlayState } from '../../core/services/api/party-api.service';

/** Drift under this is inaudible and left alone. */
export const DRIFT_IGNORE_S = 0.5;
/** Beyond this a rate nudge takes too long to converge: seek. */
export const DRIFT_SEEK_S = 3;
export const DRIFT_CHECK_MS = 2000;
export const SEEK_COOLDOWN_MS = 10_000;
export const NUDGE_SLOW = 0.95;
export const NUDGE_FAST = 1.05;

/** Where the group is at `serverNow`; before `anchor.serverTimeMs` of a playing party it is still at the anchor. */
export function groupPosition(state: PartyPlayState, anchor: PartyAnchor, serverNow: number): number {
  if (state !== 'playing') return anchor.position;
  return anchor.position + Math.max(0, serverNow - anchor.serverTimeMs) / 1000;
}

export type DriftAction =
  | { kind: 'none'; rate: 1 }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek' };

/** `drift` = local minus group, in seconds: positive means we are ahead. */
export function driftAction(
  drift: number,
  opts: { rateSupported: boolean; msSinceSeek: number; seekLocked: boolean },
): DriftAction {
  const abs = Math.abs(drift);
  if (abs < DRIFT_IGNORE_S) return { kind: 'none', rate: 1 };
  const nudge = opts.rateSupported && abs < DRIFT_SEEK_S;
  if (nudge) return { kind: 'rate', rate: drift > 0 ? NUDGE_SLOW : NUDGE_FAST };
  if (opts.seekLocked || opts.msSinceSeek < SEEK_COOLDOWN_MS) return { kind: 'none', rate: 1 };
  return { kind: 'seek' };
}
