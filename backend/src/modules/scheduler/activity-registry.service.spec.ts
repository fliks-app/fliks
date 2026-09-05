import { ActivityRegistryService } from './activity-registry.service';

function makeRegistry() {
  const events = { emit: jest.fn() };
  const registry = new ActivityRegistryService(events as never);
  return { registry, events };
}

describe('ActivityRegistryService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lists running entries before pending ones', () => {
    const { registry } = makeRegistry();
    registry.upsertPending('a', 'GenerateSprite', { title: 'A' });
    registry.upsertRunning('b', 'GenerateSprite', { title: 'B' }, 1, 10);
    const { data } = registry.list(1, 25);
    expect(data.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('keeps a stable enqueue order within a status group across a pending→running transition', () => {
    const { registry } = makeRegistry();
    registry.upsertPending('first', 'WarmupSubtitles');
    registry.upsertPending('second', 'WarmupSubtitles');
    // "first" starts running: it must not jump behind "second" just because its status changed.
    registry.upsertRunning('first', 'WarmupSubtitles', undefined, 0, 5);
    registry.upsertRunning('second', 'WarmupSubtitles', undefined, 0, 5);
    const { data } = registry.list(1, 25);
    expect(data.map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('paginates and reports the true total', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 5; i++) registry.upsertPending(`id-${i}`, 'WarmupSubtitles');
    const page1 = registry.list(1, 2);
    const page2 = registry.list(2, 2);
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(2);
    expect(page1.data.map((e) => e.id)).not.toEqual(page2.data.map((e) => e.id));
  });

  it('removes an entry when the task that owns it finishes, even on rejection', async () => {
    const { registry } = makeRegistry();
    const runTask = async (id: string, shouldFail: boolean) => {
      registry.upsertRunning(id, 'GenerateSprite', { title: 'X' }, 0, 1);
      try {
        if (shouldFail) throw new Error('boom');
      } finally {
        registry.remove(id);
      }
    };

    await expect(runTask('will-fail', true)).rejects.toThrow('boom');
    expect(registry.list(1, 25).data).toEqual([]);
  });

  it('debounces the change broadcast instead of emitting once per mutation', () => {
    const { registry, events } = makeRegistry();
    registry.upsertPending('a', 'GenerateSprite');
    registry.upsertPending('b', 'GenerateSprite');
    registry.upsertRunning('a', 'GenerateSprite', undefined, 1, 2);
    expect(events.emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(250);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith({ type: 'activity.changed' });
  });

  it('drops a fresh insert past the defensive cap without throwing, and reports the shortfall', () => {
    const { registry } = makeRegistry();
    const CAP = 20_000;
    for (let i = 0; i < CAP + 1; i++) registry.upsertPending(`id-${i}`, 'WarmupSubtitles');
    const { total, dropped } = registry.list(1, CAP + 5000);
    expect(total).toBeLessThanOrEqual(CAP);
    expect(dropped).toBeGreaterThanOrEqual(1);
  });

  describe('nesting', () => {
    it('groups children under their parent instead of listing them as siblings', () => {
      const { registry } = makeRegistry();
      registry.upsertRunning('GenerateSprites', 'GenerateSprites', undefined, 0, 2);
      registry.upsertPending('GenerateSprite:1', 'GenerateSprite', { title: 'A' }, 'GenerateSprites');
      registry.upsertPending('GenerateSprite:2', 'GenerateSprite', { title: 'B' }, 'GenerateSprites');

      const { data, total } = registry.list(1, 25);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('GenerateSprites');
      expect(data[0].children?.map((c) => c.id)).toEqual(['GenerateSprite:1', 'GenerateSprite:2']);
      // Pagination counts the parent as one unit, not 3 flat rows.
      expect(total).toBe(1);
    });

    it('orders a parent\'s children the same way as top level: running before pending, stable seq', () => {
      const { registry } = makeRegistry();
      registry.upsertRunning('Bulk', 'Bulk');
      registry.upsertPending('Bulk:1', 'Child', undefined, 'Bulk');
      registry.upsertPending('Bulk:2', 'Child', undefined, 'Bulk');
      registry.upsertRunning('Bulk:2', 'Child', undefined, 0, 1);

      const { data } = registry.list(1, 25);
      expect(data[0].children?.map((c) => c.id)).toEqual(['Bulk:2', 'Bulk:1']);
    });

    it('surfaces a child as a top-level row when its parent is not (or no longer) in the registry', () => {
      const { registry } = makeRegistry();
      // Registered before any parent exists: a producer that only registers children.
      registry.upsertPending('Orphan:1', 'GenerateSprite', undefined, 'NeverRegistered');

      const first = registry.list(1, 25);
      expect(first.data.map((r) => r.id)).toEqual(['Orphan:1']);
      expect(first.data[0].children).toBeUndefined();

      // A parent that existed, then finished/was removed while a child is still running,
      // must not orphan that child into invisibility: it surfaces top-level instead.
      registry.upsertRunning('Bulk', 'Bulk');
      registry.upsertRunning('Bulk:1', 'Child', undefined, 0, 1, 'Bulk');
      expect(registry.list(1, 25).data.map((r) => r.id).sort()).toEqual(['Bulk', 'Orphan:1']);

      registry.remove('Bulk');
      const afterParentRemoved = registry.list(1, 25);
      expect(afterParentRemoved.data.map((r) => r.id).sort()).toEqual(['Bulk:1', 'Orphan:1']);
    });

    it('removes cleanly in either order: child-then-parent and parent-then-child', () => {
      const { registry } = makeRegistry();
      registry.upsertRunning('A', 'Bulk');
      registry.upsertPending('A:1', 'Child', undefined, 'A');
      registry.remove('A:1');
      registry.remove('A');
      expect(registry.list(1, 25).data).toEqual([]);

      registry.upsertRunning('B', 'Bulk');
      registry.upsertPending('B:1', 'Child', undefined, 'B');
      registry.remove('B');
      // Child outlives its parent's removal: surfaces top-level, not dropped.
      expect(registry.list(1, 25).data.map((r) => r.id)).toEqual(['B:1']);
      registry.remove('B:1');
      expect(registry.list(1, 25).data).toEqual([]);
    });
  });
});
