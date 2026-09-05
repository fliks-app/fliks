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
    // "first" starts running — must not jump behind "second" just because it changed status.
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

  it('drops a fresh insert past the defensive cap without throwing', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 2001; i++) registry.upsertPending(`id-${i}`, 'WarmupSubtitles');
    expect(registry.list(1, 5000).total).toBeLessThanOrEqual(2000);
  });
});
