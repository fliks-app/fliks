import { InProcessPluginHostClient } from './in-process-plugin-host-client';
import type { FliksHostImpl } from './fliks-host.service';
import type { PluginHostApi } from '../../../common/plugin-contract';
import { EventsService } from '../../scheduler/events.service';

/** The 15 dotted method names `host-methods.ts` declares. */
const PLUGIN_METHOD_NAMES: (keyof PluginHostApi)[] = [
  'media.acquisitionContext',
  'acquisition.candidates',
  'releases.match',
  'releases.score',
  'media.resolve',
  'media.exists',
  'requests.markInProgress',
  'library.ingest',
  'events.publish',
  'notifications.dispatch',
  'counts.set',
  'events.emitOwn',
  'progress.set',
  'config.get',
  'config.set',
];

/** Every dotted method the contract declares, stubbed on a fake host. */
function fakeHost(): FliksHostImpl {
  const fake: Record<string, jest.Mock> = {};
  for (const name of PLUGIN_METHOD_NAMES) {
    fake[name] = jest.fn().mockResolvedValue(`result:${name}`);
  }
  return fake as unknown as FliksHostImpl;
}

describe('InProcessPluginHostClient', () => {
  it('covers exactly the 15 methods host-methods.ts declares', () => {
    expect(PLUGIN_METHOD_NAMES).toHaveLength(15);
  });

  it('forwards every one of the 15 contract methods to the host, unchanged', async () => {
    const host = fakeHost();
    const client = new InProcessPluginHostClient(host, new EventsService());
    const clientCalls = client as unknown as Record<
      string,
      (p: unknown) => Promise<unknown>
    >;
    const hostMocks = host as unknown as Record<string, jest.Mock>;

    for (const name of PLUGIN_METHOD_NAMES) {
      const payload = { probe: name };
      const result = await clientCalls[name](payload);
      expect(hostMocks[name]).toHaveBeenCalledWith(payload);
      expect(result).toBe(`result:${name}`);
    }
  });

  it('does no transformation of its own — it is a pure pass-through, not a second implementation', async () => {
    const host = fakeHost();
    const client = new InProcessPluginHostClient(host, new EventsService());
    const payload = { mediaId: 1, seasonId: 2 };
    await client['media.acquisitionContext'](payload);
    expect(host['media.acquisitionContext']).toHaveBeenCalledTimes(1);
    expect(host['media.acquisitionContext']).toHaveBeenCalledWith(payload);
  });

  describe('onEvent — the in-process push channel', () => {
    it('delivers a domain event to every subscriber, and isolates a throwing handler from the emitter and from its sibling subscribers', () => {
      const events = new EventsService();
      const client = new InProcessPluginHostClient(fakeHost(), events);
      const seen: string[] = [];

      client.onEvent(() => {
        throw new Error('plugin handler blew up');
      });
      client.onEvent((event) => {
        seen.push(event.type);
      });

      expect(() =>
        events.emitDomain({ type: 'settings.changed', key: 'foo' }),
      ).not.toThrow();
      expect(seen).toEqual(['settings.changed']);
    });

    it('isolates a rejected async handler the same way', async () => {
      const events = new EventsService();
      const client = new InProcessPluginHostClient(fakeHost(), events);
      const seen: string[] = [];

      client.onEvent(() =>
        Promise.reject(new Error('async plugin handler blew up')),
      );
      client.onEvent((event) => {
        seen.push(event.type);
      });

      events.emitDomain({ type: 'settings.changed', key: 'foo' });
      // Let the rejected microtask surface before asserting nothing escaped.
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual(['settings.changed']);
    });

    it('stops delivering once unsubscribed', () => {
      const events = new EventsService();
      const client = new InProcessPluginHostClient(fakeHost(), events);
      const seen: string[] = [];

      const subscription = client.onEvent((event) => {
        seen.push(event.type);
      });
      subscription.unsubscribe();
      events.emitDomain({ type: 'settings.changed', key: 'foo' });

      expect(seen).toEqual([]);
    });
  });
});
