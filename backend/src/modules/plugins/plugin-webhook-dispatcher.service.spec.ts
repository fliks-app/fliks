import axios, { AxiosRequestConfig } from 'axios';
import * as dns from 'dns';
import { PluginWebhookDispatcherService } from './plugin-webhook-dispatcher.service';
import type { SettingsService } from '../settings/settings.service';
import { EventsService } from '../scheduler/events.service';
import { PluginRegistryService } from './plugin-registry.service';

jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));

function registryStub(map: Record<string, { pluginId: string; webhook: string }[]>): PluginRegistryService {
  return { listWebhooksForEvent: jest.fn((eventType: string) => map[eventType] ?? []) } as unknown as PluginRegistryService;
}

/** Only `get` is reached: a `setting:` webhook resolves through it, a literal URL never touches it. */
function settingsStub(values: Record<string, string> = {}) {
  return { get: async (key: string) => values[key] ?? null } as unknown as SettingsService;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PluginWebhookDispatcherService', () => {
  const originalAdapter = axios.defaults.adapter;
  let requests: { url: string; data: unknown }[];
  const lookupMock = jest.mocked(dns.promises.lookup);

  beforeEach(() => {
    requests = [];
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    axios.defaults.adapter = (config: AxiosRequestConfig) => {
      requests.push({ url: String(config.url), data: config.data ? JSON.parse(String(config.data)) : undefined });
      return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('delivers a fired event to the plugin subscribed to it', async () => {
    const registry = registryStub({
      'media.imported': [{ pluginId: 'fliks.plugin-a', webhook: 'https://hooks.example/a' }],
    });
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    events.emitDomain({ type: 'media.imported', mediaId: 1, tmdbId: null, mediaType: 'movie', libraryId: null, addedByUserId: null });
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://hooks.example/a');
  });

  it('does not deliver to a plugin subscribed to a different event', async () => {
    const registry = registryStub({}); // nothing subscribed to media.removed
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    events.emitDomain({ type: 'media.removed', mediaId: 1, tmdbId: null, mediaType: 'movie' });
    await flush();

    expect(requests).toHaveLength(0);
  });

  it('delivers to two plugins subscribed to the same event', async () => {
    const registry = registryStub({
      'settings.changed': [
        { pluginId: 'fliks.plugin-a', webhook: 'https://hooks.example/a' },
        { pluginId: 'fliks.plugin-b', webhook: 'https://hooks.example/b' },
      ],
    });
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    events.emitDomain({ type: 'settings.changed', key: 'library_path' });
    await flush();

    expect(requests.map((r) => r.url).sort()).toEqual(['https://hooks.example/a', 'https://hooks.example/b']);
  });

  it('does not call out when the host resolves to a private address at dispatch time (DNS rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    const registry = registryStub({
      'settings.changed': [{ pluginId: 'fliks.rebinder', webhook: 'https://rebinder.example/hook' }],
    });
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    events.emitDomain({ type: 'settings.changed', key: 'x' });
    await flush();

    expect(requests).toHaveLength(0);
  });

  it('logs and swallows a rejecting webhook, and still delivers to a second plugin for the same event', async () => {
    const registry = registryStub({
      'settings.changed': [
        { pluginId: 'fliks.failing', webhook: 'https://failing.example/hook' },
        { pluginId: 'fliks.ok', webhook: 'https://ok.example/hook' },
      ],
    });
    axios.defaults.adapter = (config: AxiosRequestConfig) => {
      if (String(config.url).includes('failing')) return Promise.reject(new Error('timeout')) as never;
      requests.push({ url: String(config.url), data: config.data ? JSON.parse(String(config.data)) : undefined });
      return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    // emitDomain is synchronous and void — the caller (and the emitter's own contract) is never affected.
    expect(() => events.emitDomain({ type: 'settings.changed', key: 'x' })).not.toThrow();
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://ok.example/hook');
  });

  it('POSTs exactly the event and the plugin id — nothing else', async () => {
    const registry = registryStub({
      'media.removed': [{ pluginId: 'fliks.plugin-a', webhook: 'https://hooks.example/a' }],
    });
    const events = new EventsService();
    new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

    events.emitDomain({ type: 'media.removed', mediaId: 42, tmdbId: 99, mediaType: 'movie' });
    await flush();

    expect(requests[0].data).toEqual({
      event: { type: 'media.removed', mediaId: 42, tmdbId: 99, mediaType: 'movie' },
      pluginId: 'fliks.plugin-a',
    });
  });

    it("VERDICT: resolves `setting:` to the operator's own URL and posts there", async () => {
      const registry = registryStub({
        'media.imported': [{ pluginId: 'fliks.acme', webhook: 'setting:endpoint_url' }],
      });
      const events = new EventsService();
      const settings = settingsStub({ 'plugin.fliks.acme.endpoint_url': 'https://hooks.example/mine' });
      new PluginWebhookDispatcherService(events, registry, settings).onModuleInit();

      events.emitDomain({ type: 'media.imported', mediaId: 1, tmdbId: null, mediaType: 'movie', libraryId: null, addedByUserId: null });
      await flush();

      expect(requests.map((r) => r.url)).toEqual(['https://hooks.example/mine']);
    });

    it('posts nothing while the endpoint is unset — an operator who has not filled it in is not a failure', async () => {
      const registry = registryStub({
        'media.imported': [{ pluginId: 'fliks.acme', webhook: 'setting:endpoint_url' }],
      });
      const events = new EventsService();
      new PluginWebhookDispatcherService(events, registry, settingsStub()).onModuleInit();

      events.emitDomain({ type: 'media.imported', mediaId: 1, tmdbId: null, mediaType: 'movie', libraryId: null, addedByUserId: null });
      await flush();

      expect(requests).toHaveLength(0);
    });

    it('refuses a configured endpoint that is not https', async () => {
      const registry = registryStub({
        'media.imported': [{ pluginId: 'fliks.acme', webhook: 'setting:endpoint_url' }],
      });
      const events = new EventsService();
      const settings = settingsStub({ 'plugin.fliks.acme.endpoint_url': 'http://hooks.example/mine' });
      new PluginWebhookDispatcherService(events, registry, settings).onModuleInit();

      events.emitDomain({ type: 'media.imported', mediaId: 1, tmdbId: null, mediaType: 'movie', libraryId: null, addedByUserId: null });
      await flush();

      expect(requests).toHaveLength(0);
  });

    it('posts one synthetic event per declaration, through the same guards', async () => {
      const registry = {
        listWebhooksForEvent: () => [],
        listWebhooksForPlugin: () => [{ event: 'media.imported', webhook: 'setting:endpoint_url' }],
      } as unknown as PluginRegistryService;
      const settings = settingsStub({ 'plugin.fliks.acme.endpoint_url': 'https://hooks.example/mine' });
      const service = new PluginWebhookDispatcherService(new EventsService(), registry, settings);

      const result = await service.sendTest('fliks.acme');

      expect(result).toEqual({ configured: true, delivered: 1, failures: [] });
      expect(requests.map((r) => r.url)).toEqual(['https://hooks.example/mine']);
    });

    it('VERDICT: reports "not configured" instead of sending anywhere when the endpoint is empty', async () => {
      const registry = {
        listWebhooksForEvent: () => [],
        listWebhooksForPlugin: () => [{ event: 'media.imported', webhook: 'setting:endpoint_url' }],
      } as unknown as PluginRegistryService;
      const service = new PluginWebhookDispatcherService(new EventsService(), registry, settingsStub());

      const result = await service.sendTest('fliks.acme');

      expect(result).toEqual({ configured: false, delivered: 0, failures: [] });
      expect(requests).toHaveLength(0);
  });
});
