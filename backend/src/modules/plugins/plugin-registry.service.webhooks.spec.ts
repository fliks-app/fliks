import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';
import type { PluginManifest, PluginWebhookDeclaration } from '../../common/plugin-contract';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    // Webhook validation never re-verifies the archive (verifiedByKeyId is null), so its bytes don't matter.
    archive: Buffer.alloc(0),
    origin: 'manual',
    signature: 'unsigned',
    verifiedByKeyId: null,
    manifest,
    status: 'active',
    ...overrides,
  } as PluginPackage;
}

function repoMock(): { find: jest.Mock } {
  return { find: jest.fn().mockResolvedValue([]) };
}

function webhookDeclaration(overrides: Partial<PluginWebhookDeclaration> = {}): PluginWebhookDeclaration {
  return { event: 'media.imported', webhook: 'https://hooks.example.com/fliks', ...overrides };
}

describe('PluginRegistryService — webhooks', () => {
  it('refuses a plain-http webhook URL', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      events: [webhookDeclaration({ webhook: 'http://hooks.example.com/fliks' })],
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'insecure-webhook-scheme',
      detail: expect.any(String),
    });
  });

  it.each([
    ['loopback', 'https://127.0.0.1/hook'],
    ['RFC1918', 'https://10.0.0.5/hook'],
    ['link-local', 'https://169.254.169.254/hook'],
  ])('refuses an IP-literal %s webhook host', async (_label, webhook) => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      events: [webhookDeclaration({ webhook })],
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'internal-webhook-host',
      detail: expect.stringContaining(new URL(webhook).hostname),
    });
  });

  it('refuses a malformed webhook URL', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      events: [webhookDeclaration({ webhook: 'not-a-url' })],
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-webhook-url',
      detail: expect.stringContaining('not-a-url'),
    });
  });

  it('refuses an event name outside the domain-event catalog', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      events: [{ event: 'media.deleted-forever', webhook: 'https://hooks.example.com/fliks' } as unknown as PluginWebhookDeclaration],
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-webhook-event',
      detail: expect.stringContaining('media.deleted-forever'),
    });
  });

  it('registers a valid https webhook on a public host and exposes it to the dispatcher', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      events: [webhookDeclaration()],
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.listWebhooksForEvent('media.imported')).toEqual([
      { pluginId: manifest.id, webhook: 'https://hooks.example.com/fliks' },
    ]);
  });

  it('drops a plugin webhooks on unregister', async () => {
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE, events: [webhookDeclaration()] });
    const service = new PluginRegistryService(repoMock() as never);
    await service.register(makePackage(manifest));
    expect(service.listWebhooksForEvent('media.imported')).toHaveLength(1);

    service.unregister(manifest.id);

    expect(service.listWebhooksForEvent('media.imported')).toEqual([]);
  });

  it('refuses a process-tier manifest declaring a webhook (process is not a supported tier yet)', async () => {
    const manifest = minimalProcessManifest(
      { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
      { fliks: COMPATIBLE_RANGE, events: [webhookDeclaration()] },
    );
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'unsupported-tier',
      detail: expect.any(String),
    });
    expect(service.listWebhooksForEvent('media.imported')).toEqual([]);
  });
});
