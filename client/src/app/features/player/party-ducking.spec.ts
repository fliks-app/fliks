import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DUCK_FACTOR, RELEASE_HOLD_MS, VoiceDucker } from './party-ducking';

describe('VoiceDucker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (supportsVolume = true) => {
    const engine = { volume: 0.8, supportsVolume };
    const writes: number[] = [];
    const ducker = new VoiceDucker(() => engine, () => 0.8, (l) => writes.push(l));
    return { engine, writes, ducker };
  };

  it('ramps down to the duck factor then back to the user level', () => {
    const { engine, ducker } = setup();
    ducker.set(true);
    vi.advanceTimersByTime(400);
    expect(engine.volume).toBeCloseTo(0.8 * DUCK_FACTOR);
    ducker.set(false);
    vi.advanceTimersByTime(RELEASE_HOLD_MS + 400);
    expect(engine.volume).toBeCloseTo(0.8);
  });

  it('stays ducked through a pause shorter than the hold', () => {
    const { engine, ducker } = setup();
    ducker.set(true);
    vi.advanceTimersByTime(400);
    ducker.set(false);
    vi.advanceTimersByTime(RELEASE_HOLD_MS - 100);
    ducker.set(true);
    vi.advanceTimersByTime(RELEASE_HOLD_MS + 400);
    expect(engine.volume).toBeCloseTo(0.8 * DUCK_FACTOR);
  });

  it('announces every level it writes', () => {
    const { engine, writes, ducker } = setup();
    ducker.set(true);
    vi.advanceTimersByTime(400);
    expect(writes.at(-1)).toBeCloseTo(engine.volume);
    expect(writes.length).toBeGreaterThan(2);
  });

  it('does nothing when not ducked, or when the engine owns the level', () => {
    const a = setup();
    a.ducker.set(false);
    vi.advanceTimersByTime(400);
    expect(a.writes).toEqual([]);
    const b = setup(false);
    b.ducker.set(true);
    vi.advanceTimersByTime(400);
    expect(b.engine.volume).toBe(0.8);
  });

  it('stop restores the level at once', () => {
    const { engine, ducker } = setup();
    ducker.set(true);
    vi.advanceTimersByTime(400);
    ducker.stop();
    expect(engine.volume).toBe(0.8);
  });
});
