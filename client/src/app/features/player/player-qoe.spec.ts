import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerQoe, SAMPLE_TIMEOUT_MS, StallTracker } from './player-qoe';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { QoeReporter } from '../../core/services/qoe-reporter.service';

describe('StallTracker', () => {
  it('counts a completed stall and its duration', () => {
    const t = new StallTracker();
    t.begin(1000, 5, false);
    expect(t.end(3000)).toEqual({ durationMs: 2000, position: 5, bufferAheadS: null });
    expect(t.snapshot(4000)).toEqual({ stallCount: 1, stallMs: 2000 });
  });

  it('keeps the first begin of an episode', () => {
    const t = new StallTracker();
    t.begin(1000, 5, false);
    t.begin(2000, 9, true);
    expect(t.end(3000)).toEqual({ durationMs: 2000, position: 5, bufferAheadS: null });
  });

  it('ignores seek/reload episodes and sub-threshold blips', () => {
    const t = new StallTracker();
    t.begin(0, 0, true);
    expect(t.end(5000)).toBeNull();
    t.begin(6000, 0, false);
    expect(t.end(6100)).toBeNull();
    expect(t.snapshot(7000)).toEqual({ stallCount: 0, stallMs: 0 });
  });

  it('does not count an open stall before the minimum duration', () => {
    const t = new StallTracker();
    t.begin(1000, 0, false);
    expect(t.snapshot(1100)).toEqual({ stallCount: 0, stallMs: 0 });
  });

  it('includes an open stall in the snapshot', () => {
    const t = new StallTracker();
    t.begin(1000, 0, false);
    expect(t.snapshot(1800)).toEqual({ stallCount: 1, stallMs: 800 });
  });
});

describe('PlayerQoe', () => {
  let now = 0;
  const reporter = { record: vi.fn(), flush: vi.fn(), flushKeepalive: vi.fn() };
  const engine = (impl: () => Promise<unknown>) =>
    ({ getQoeSample: vi.fn(impl) }) as unknown as PlaybackEngine;
  const raw = { engine: 'shaka', cmcd: true, bufferAheadS: 3, bandwidthBps: 9, variantBitrate: 5 };
  let qoe: PlayerQoe;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers();
    reporter.record.mockReset();
    qoe = new PlayerQoe(reporter as unknown as QoeReporter, () => now);
  });
  afterEach(() => vi.useRealTimers());

  it('emits a stall event with the latest sample context', async () => {
    await qoe.refresh(engine(async () => raw));
    now = 1000;
    qoe.setStalled(true, { sessionId: 's', position: 12, bufferAheadS: 0.4 });
    now = 3500;
    qoe.setStalled(false, { sessionId: 's', position: 12 });
    expect(reporter.record).toHaveBeenCalledWith(
      's',
      { type: 'stall', at: 3500, position: 12, durationMs: 2500, bufferAheadS: 0.4, bandwidthBps: 9 },
      false,
    );
  });

  it('merges counters into the current sample and restarts them on reset', async () => {
    await qoe.refresh(engine(async () => raw));
    qoe.onRecovery('s', 1);
    now = 10;
    qoe.setStalled(true, { sessionId: 's', position: 1 });
    now = 1010;
    expect(qoe.current('s')).toMatchObject({ stallCount: 1, stallMs: 1000, recoveryReloads: 1 });
    qoe.reset();
    await qoe.refresh(engine(async () => raw));
    expect(qoe.current('s')).toMatchObject({ stallCount: 0, stallMs: 0, recoveryReloads: 0 });
  });

  it('restarts the counters when a recovery mints a new session id', async () => {
    await qoe.refresh(engine(async () => raw));
    expect(qoe.current('a')).not.toBeNull();
    qoe.onRecovery('a', 1);
    qoe.onRecovery('b', 2);
    await qoe.refresh(engine(async () => raw));
    expect(qoe.current('b')).toMatchObject({ recoveryReloads: 1 });
  });

  it('closes the open stall under the old sid when the sid changes', async () => {
    await qoe.refresh(engine(async () => raw));
    qoe.current('a');
    now = 1000;
    qoe.setStalled(true, { sessionId: 'a', position: 3, bufferAheadS: 0 });
    now = 4000;
    qoe.current('b');
    expect(reporter.record).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ type: 'stall', durationMs: 3000 }),
      false,
    );
    expect(qoe.current('b')).toBeNull();
  });

  it('drops a sample that resolves after the sid changed', async () => {
    qoe.current('a');
    let resolve!: (v: unknown) => void;
    const pending = qoe.refresh(engine(() => new Promise((r) => (resolve = r))));
    await vi.advanceTimersByTimeAsync(1);
    qoe.current('b');
    resolve(raw);
    await pending;
    expect(qoe.current('b')).toBeNull();
  });

  it('flushes errors immediately', () => {
    qoe.onError('s', 4, { code: 3016, category: 'shaka' });
    expect(reporter.record).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ type: 'error', code: 3016, category: 'shaka' }),
      true,
    );
  });

  it('keeps no sample when the engine throws, has none, or is too slow', async () => {
    await qoe.refresh(engine(async () => { throw new Error('x'); }));
    await qoe.refresh(engine(async () => null));
    const slow = qoe.refresh(engine(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(SAMPLE_TIMEOUT_MS);
    await slow;
    expect(qoe.current('s')).toBeNull();
  });
});
