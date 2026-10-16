import { EventsService, type SseEvent } from './events.service';
import { ActivityRegistryService } from './activity-registry.service';

const ENV = { ...process.env };

function mockFetch(
  answer: () => Partial<Response> = () => ({ ok: true, status: 204 }),
) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
    calls.push({
      path: (url as string).replace('http://rust', ''),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve(answer() as Response);
  });
  return calls;
}

beforeEach(() => {
  process.env.FLIKS_SERVER_URL = 'http://rust';
  process.env.FLIKS_BRIDGE_TOKEN = 'tok';
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

describe('EventsService (forwarder)', () => {
  const queue: SseEvent = { type: 'queue.updated' };
  const flush = () => new Promise((r) => setImmediate(r));

  it('forwards every emit to the hub in call order, never locally', async () => {
    const calls = mockFetch();
    const events = new EventsService();
    const seen = jest.fn();
    events.subscribe(seen);
    events.emit(queue);
    events.emitToUser(3, queue);
    events.emitToUsers([1, 2], queue);
    events.emitRaw('plugin.a.b', { x: 1 }, null);
    events.emitRaw('plugin.a.b', { x: 1 }, [4]);
    events.emitDomain({ type: 'settings.changed', key: 'k' });
    await flush();
    expect(calls.map((c) => c.body)).toEqual([
      { kind: 'sse', event: queue },
      { kind: 'sse', event: queue, userId: 3 },
      { kind: 'sse', event: queue, userIds: [1, 2] },
      { kind: 'raw', event: { type: 'plugin.a.b', payload: { x: 1 } } },
      {
        kind: 'raw',
        event: { type: 'plugin.a.b', payload: { x: 1 } },
        userIds: [4],
      },
      { kind: 'domain', event: { type: 'settings.changed', key: 'k' } },
    ]);
    expect(
      calls.every((c) => c.path === '/internal/events' && c.method === 'POST'),
    ).toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });

  it('keeps forwarding after a failed delivery', async () => {
    const calls = mockFetch(() => ({ ok: false, status: 500 }));
    const events = new EventsService();
    events.emit(queue);
    events.emit(queue);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('re-emits the internal stream to its subscribers, isolating domain handler errors', async () => {
    const events = new EventsService();
    const sse = jest.fn();
    const domain = jest.fn();
    events.subscribe(sse);
    events.onDomain(() => {
      throw new Error('boom');
    });
    events.onDomain(domain);
    const dispatch = (
      events as unknown as { dispatch(b: string): void }
    ).dispatch.bind(events);
    dispatch(': keep-alive');
    dispatch(
      'data: {"kind":"sse","event":{"type":"rescan.completed","mediaId":1}}',
    );
    dispatch('data: {"kind":"raw","event":{"type":"plugin.a.b","payload":1}}');
    dispatch(
      'data: {"kind":"domain","event":{"type":"settings.changed","key":"k"}}',
    );
    dispatch('data: not json');
    await flush();
    expect(sse.mock.calls.map(([e]: [SseEvent]) => e.type)).toEqual([
      'rescan.completed',
      'plugin.a.b',
    ]);
    expect(domain).toHaveBeenCalledWith({ type: 'settings.changed', key: 'k' });
  });

  it('does nothing without the bridge env', async () => {
    delete process.env.FLIKS_SERVER_URL;
    const calls = mockFetch();
    new EventsService().emit(queue);
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe('ActivityRegistryService (bridge client)', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('sends mutations and claims in call order', async () => {
    const calls = mockFetch();
    const registry = new ActivityRegistryService();
    registry.upsertPending('Rescan:1', 'Rescan', { title: 'T' }, 'p');
    registry.upsertRunning('Rescan:1', 'Rescan', undefined, 1, 2);
    registry.remove('Rescan:1');
    await expect(registry.claim('Rescan:1', 'Rescan')).resolves.toBe(true);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      [
        'POST',
        '/internal/activity',
        {
          op: 'pending',
          id: 'Rescan:1',
          type: 'Rescan',
          subject: { title: 'T' },
          parentId: 'p',
        },
      ],
      [
        'POST',
        '/internal/activity',
        { op: 'running', id: 'Rescan:1', type: 'Rescan', current: 1, total: 2 },
      ],
      ['POST', '/internal/activity', { op: 'remove', id: 'Rescan:1' }],
      ['POST', '/internal/activity/claim', { id: 'Rescan:1', type: 'Rescan' }],
    ]);
    await flush();
  });

  it('answers false on 409 and rethrows other failures', async () => {
    let status = 409;
    mockFetch(() => ({ ok: false, status, json: () => Promise.resolve({}) }));
    const registry = new ActivityRegistryService();
    await expect(registry.claim('x', 'T')).resolves.toBe(false);
    status = 500;
    await expect(registry.claim('x', 'T')).rejects.toThrow('answered 500');
  });

  it('claims without the bridge env', async () => {
    delete process.env.FLIKS_BRIDGE_TOKEN;
    await expect(new ActivityRegistryService().claim('x', 'T')).resolves.toBe(
      true,
    );
  });
});
