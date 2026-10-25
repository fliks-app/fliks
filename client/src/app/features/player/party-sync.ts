import type { PartyAnchor, PartyPlayState } from '../../core/services/api/party-api.service';

/** Drift under this is inaudible and left alone. */
export const DRIFT_IGNORE_S = 0.5;
/** Beyond this a rate nudge takes too long to converge: seek. */
export const DRIFT_SEEK_S = 3;
export const DRIFT_CHECK_MS = 2000;
export const SEEK_COOLDOWN_MS = 10_000;
/** Cast `currentTime` is polled and coarse: a wider dead band, seek only, rarer corrections. */
export const CAST_DRIFT_IGNORE_S = 1.5;
export const CAST_SEEK_COOLDOWN_MS = 15_000;
/** TV engines cannot nudge the rate and land seeks on keyframes: a wide dead band, rare corrections. */
export const NO_RATE_DRIFT_IGNORE_S = 1.5;
export const NO_RATE_SEEK_COOLDOWN_MS = 25_000;
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
  opts: { rateSupported: boolean; msSinceSeek: number; seekLocked: boolean; ignoreS?: number; cooldownMs?: number },
): DriftAction {
  const abs = Math.abs(drift);
  if (abs < (opts.ignoreS ?? DRIFT_IGNORE_S)) return { kind: 'none', rate: 1 };
  const nudge = opts.rateSupported && abs < DRIFT_SEEK_S;
  if (nudge) return { kind: 'rate', rate: drift > 0 ? NUDGE_SLOW : NUDGE_FAST };
  if (opts.seekLocked || opts.msSinceSeek < (opts.cooldownMs ?? SEEK_COOLDOWN_MS)) return { kind: 'none', rate: 1 };
  return { kind: 'seek' };
}

/** Dead band and seek cooldown for an engine whose position moves in `positionStepS` steps (0 = continuous). */
export function driftProfile(o: { positionStepS: number; rateSupported: boolean }): { ignoreS: number; cooldownMs: number } {
  const ignoreS = DRIFT_IGNORE_S + o.positionStepS;
  if (o.rateSupported) return { ignoreS, cooldownMs: SEEK_COOLDOWN_MS };
  return { ignoreS: Math.max(ignoreS, NO_RATE_DRIFT_IGNORE_S), cooldownMs: NO_RATE_SEEK_COOLDOWN_MS };
}
