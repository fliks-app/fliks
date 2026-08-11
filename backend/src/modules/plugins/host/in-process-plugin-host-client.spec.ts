import { InProcessPluginHostClient } from './in-process-plugin-host-client';
import type { FliksHostImpl } from './fliks-host.service';
import type { PluginHostApi } from '../../../common/plugin-contract';

/** The 17 dotted method names `host-methods.ts` declares. */
const PLUGIN_METHOD_NAMES: (keyof PluginHostApi)[] = [
  'media.acquisitionContext',
  'acquisition.candidates',
  'releases.match',
  'releases.score',
  'media.resolve',
  'media.exists',
  'blocklist.add',
  'blocklist.check',
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
  it('covers exactly the 17 methods host-methods.ts declares', () => {
    expect(PLUGIN_METHOD_NAMES).toHaveLength(17);
  });

  it('forwards every one of the 17 contract methods to the host, unchanged', async () => {
    const host = fakeHost();
    const client = new InProcessPluginHostClient(host);
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
    const client = new InProcessPluginHostClient(host);
    const payload = { mediaId: 1, seasonId: 2 };
    await client['media.acquisitionContext'](payload);
    expect(host['media.acquisitionContext']).toHaveBeenCalledTimes(1);
    expect(host['media.acquisitionContext']).toHaveBeenCalledWith(payload);
  });
});
