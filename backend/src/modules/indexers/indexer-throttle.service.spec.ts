import { IndexerThrottle } from './indexer-throttle.service';
import { Indexer } from './entities/indexer.entity';

const indexer = (over: Partial<Indexer> = {}): Indexer =>
  ({ id: 1, name: 'test', requestDelay: 0, ...over }) as Indexer;

describe('IndexerThrottle cooldown gate', () => {
  it('reports no cooldown for an untouched indexer', () => {
    const t = new IndexerThrottle();
    expect(t.cooldownRemainingMs(1)).toBe(0);
  });

  it('opens a cooldown window on the first failure', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer());
    // First failure backs off 30s.
    expect(t.cooldownRemainingMs(1)).toBeGreaterThan(25_000);
    expect(t.cooldownRemainingMs(1)).toBeLessThanOrEqual(30_000);
  });

  it('escalates once the open window has elapsed', () => {
    jest.useFakeTimers();
    try {
      const t = new IndexerThrottle();
      t.notifyFailure(indexer());
      jest.advanceTimersByTime(30_000);
      t.notifyFailure(indexer());
      // Second failure after the 30s window escalates to 2min.
      expect(t.cooldownRemainingMs(1)).toBeGreaterThan(30_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not escalate on failures inside the open window', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer());
    const afterOne = t.cooldownRemainingMs(1);
    // A network-wide outage fails every queued request; escalating on each
    // would burn the whole ladder to the 6h cap within seconds.
    t.notifyFailure(indexer());
    t.notifyFailure(indexer());
    expect(t.cooldownRemainingMs(1)).toBeLessThanOrEqual(afterOne);
  });

  it('clears the cooldown on confirmed success', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer());
    expect(t.cooldownRemainingMs(1)).toBeGreaterThan(0);
    t.notifySuccess(1);
    expect(t.cooldownRemainingMs(1)).toBe(0);
  });

  it('honours Retry-After as a cooldown window', () => {
    const t = new IndexerThrottle();
    t.setRetryAfter(indexer(), '120');
    expect(t.cooldownRemainingMs(1)).toBeGreaterThan(110_000);
    expect(t.cooldownRemainingMs(1)).toBeLessThanOrEqual(120_000);
  });

  it('does not count routine request spacing as a cooldown', async () => {
    const t = new IndexerThrottle();
    // A healthy call bumps the per-indexer request-delay gate but must not
    // make the indexer read as "in cooldown" — searches still query it.
    await t.run(indexer({ requestDelay: 5 }), async () => 'ok');
    expect(t.cooldownRemainingMs(1)).toBe(0);
  });
});

describe('IndexerThrottle cooldown reporting', () => {
  it('reports the failure reason and count', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer(), 'ECONNREFUSED');
    expect(t.getCooldown(1)).toMatchObject({
      reason: 'failures',
      failureCount: 1,
      detail: 'ECONNREFUSED',
    });
  });

  it('reports the rate-limit reason with the header value', () => {
    const t = new IndexerThrottle();
    t.setRetryAfter(indexer(), '120');
    expect(t.getCooldown(1)).toMatchObject({
      reason: 'rate-limit',
      detail: '120',
    });
  });

  it('reports nothing once the window has elapsed', () => {
    jest.useFakeTimers();
    try {
      const t = new IndexerThrottle();
      t.notifyFailure(indexer());
      jest.advanceTimersByTime(30_001);
      expect(t.getCooldown(1)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('IndexerThrottle cooldown reset', () => {
  it('lifts the window and restarts the failure ladder', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer());
    expect(t.clearCooldown(1)).toBe(true);
    expect(t.cooldownRemainingMs(1)).toBe(0);
    // Ladder restarted: the next failure is the 30s step again, not 2min.
    t.notifyFailure(indexer());
    expect(t.cooldownRemainingMs(1)).toBeLessThanOrEqual(30_000);
  });

  it('lets a request run immediately after a reset', async () => {
    const t = new IndexerThrottle();
    t.setRetryAfter(indexer(), '3600');
    t.clearCooldown(1);
    // The queue gate was pushed to the same instant as the skip gate; if the
    // reset left it set, this call would sleep an hour instead of running.
    const ran = await Promise.race([
      t.run(indexer(), async () => 'ok'),
      new Promise((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(ran).toBe('ok');
  });

  it('reports false when there was nothing to lift', () => {
    const t = new IndexerThrottle();
    expect(t.clearCooldown(1)).toBe(false);
  });

  it('counts only the indexers actually in cooldown', () => {
    const t = new IndexerThrottle();
    t.notifyFailure(indexer({ id: 1 }));
    t.notifyFailure(indexer({ id: 2, name: 'other' }));
    t.clearCooldown(2);
    expect(t.clearAllCooldowns()).toBe(1);
    expect(t.cooldownRemainingMs(1)).toBe(0);
  });
});
