import { describe, expect, it } from 'vitest';
import { CAST_DRIFT_IGNORE_S, CAST_SEEK_COOLDOWN_MS, driftAction, driftProfile, groupPosition } from './party-drift';

const opts = { rateSupported: true, msSinceSeek: 60_000, seekLocked: false };

describe('groupPosition', () => {
  const anchor = { position: 100, serverTimeMs: 5000 };
  it('extrapolates while playing', () => {
    expect(groupPosition('playing', anchor, 8000)).toBe(103);
  });
  it('holds the anchor before a scheduled start', () => {
    expect(groupPosition('playing', anchor, 4000)).toBe(100);
  });
  it('holds the anchor when not playing', () => {
    expect(groupPosition('paused', anchor, 99_000)).toBe(100);
  });
});

describe('driftAction', () => {
  it('ignores under half a second', () => {
    expect(driftAction(0.4, opts).kind).toBe('none');
    expect(driftAction(-0.49, opts).kind).toBe('none');
  });
  it('nudges the rate between 0.5 and 3 s', () => {
    expect(driftAction(1, opts)).toEqual({ kind: 'rate', rate: 0.95 });
    expect(driftAction(-2, opts)).toEqual({ kind: 'rate', rate: 1.05 });
  });
  it('seeks over 3 s', () => {
    expect(driftAction(4, opts).kind).toBe('seek');
  });
  it('seeks instead of nudging where the engine has no fractional rate', () => {
    expect(driftAction(1, { ...opts, rateSupported: false }).kind).toBe('seek');
  });
  it('rate-limits corrective seeks and never seeks while locked', () => {
    expect(driftAction(5, { ...opts, msSinceSeek: 9000 }).kind).toBe('none');
    expect(driftAction(5, { ...opts, seekLocked: true }).kind).toBe('none');
  });
});

describe('driftAction on cast', () => {
  const cast = { rateSupported: false, msSinceSeek: 60_000, seekLocked: false, ignoreS: CAST_DRIFT_IGNORE_S, cooldownMs: CAST_SEEK_COOLDOWN_MS };
  it('leaves drift inside the 1.5 s band alone', () => {
    expect(driftAction(1.4, cast).kind).toBe('none');
    expect(driftAction(-1.49, cast).kind).toBe('none');
  });
  it('seeks, never nudges the rate, past the band', () => {
    expect(driftAction(1.6, cast).kind).toBe('seek');
    expect(driftAction(-2, cast).kind).toBe('seek');
  });
  it('allows one corrective seek per 15 s', () => {
    expect(driftAction(5, { ...cast, msSinceSeek: 14_000 }).kind).toBe('none');
    expect(driftAction(5, { ...cast, msSinceSeek: 15_000 }).kind).toBe('seek');
  });
});

describe('driftProfile', () => {
  it('keeps the web defaults for a continuous position with rate support', () => {
    expect(driftProfile({ positionStepS: 0, rateSupported: true })).toEqual({ ignoreS: 0.5, cooldownMs: 10_000 });
  });
  it('widens the dead band by the position step so an in-sync device is not nudged', () => {
    expect(driftProfile({ positionStepS: 1, rateSupported: true }).ignoreS).toBe(1.5);
  });
  it('uses a wide band and a long cooldown without rate support', () => {
    expect(driftProfile({ positionStepS: 0, rateSupported: false })).toEqual({ ignoreS: 1.5, cooldownMs: 25_000 });
  });
});
