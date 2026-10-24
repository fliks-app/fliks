import { describe, expect, it } from 'vitest';
import { driftAction, groupPosition } from './party-sync';

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
