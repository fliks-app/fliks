import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry } from './plugin-registry.test-helpers';
import type { PluginManifest, PluginRoute } from '../../common/plugin-contract';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    // Permission/route validation runs before any archive materialisation — bytes never matter here.
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

function makeService(): PluginRegistryService {
  return new PluginRegistryService(
    repoMock() as never,
    fakeRegistrationRepo() as never,
    fakeProcessService() as never,
    fakePluginJobsService() as never,
    fakeScheduledJobRegistry() as never,
  );
}

function processManifest(
  pluginId: string,
  permissions: unknown[],
  routes: PluginRoute[] = [],
): PluginManifest {
  return {
    ...minimalProcessManifest({ 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) }, {
      id: pluginId,
      fliks: COMPATIBLE_RANGE,
      routes,
    }),
    permissions,
  } as unknown as PluginManifest;
}

describe('PluginRegistryService — permission namespacing (adversarial table)', () => {
  it.each([
    ['core wildcard action:subject', 'manage:all'],
    ['a core subject name', 'Settings'],
    ['a core dotted permission', 'media.read'],
    ['a bare glob', '*'],
    ['path-traversal-shaped', '..'],
    ['empty string', ''],
    ['contains a colon', 'down:load'],
    ['contains a space', 'down load'],
    ['contains uppercase', 'Download'],
    ['already carries another plugin id, dotted', 'otherplugin.download'],
    ['already carries another plugin id, namespaced', 'plugin:fliks.other:download'],
    ['very long', 'a'.repeat(200)],
  ])('refuses %s ("%s")', async (_label, name) => {
    const manifest = processManifest('fliks.permtest', [name]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: 'fliks.permtest', reason: 'invalid-permission', detail: expect.any(String) });
  });

  it('refuses a duplicate permission name within the same plugin', async () => {
    const manifest = processManifest('fliks.permtest', ['download', 'download']);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: 'fliks.permtest',
      reason: 'invalid-permission',
      detail: expect.stringContaining('duplicate'),
    });
  });

  it('accepts "all" as a raw name — once namespaced it can never equal the CASL wildcard subject', async () => {
    const manifest = processManifest('fliks.permtest', ['all']);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: true, pluginId: 'fliks.permtest' });
  });

  it('accepts a well-formed permission name and namespaces it under the plugin id', async () => {
    const manifest = processManifest('fliks.permtest', ['download']);
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: 'fliks.permtest' });
    expect(service.declaredPermissionsFor('fliks.permtest')).toEqual(new Set(['plugin:fliks.permtest:download']));
  });
});

describe('PluginRegistryService — a route may only authorize against its own plugin\'s subject', () => {
  it('accepts a route policy naming a subject this same plugin declared', async () => {
    const manifest = processManifest('fliks.a', ['download'], [
      { method: 'GET', path: '/queue', policy: 'read:plugin:fliks.a:download' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: true, pluginId: 'fliks.a' });
  });

  it('refuses a route policy naming another plugin\'s namespaced subject, even with the same permission name declared', async () => {
    // fliks.a declares "download" itself, but its route reaches for fliks.b's namespace —
    // never the same subject even though the bare name matches.
    const manifest = processManifest('fliks.a', ['download'], [
      { method: 'GET', path: '/queue', policy: 'read:plugin:fliks.b:download' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: 'fliks.a',
      reason: 'invalid-route-policy',
      detail: expect.any(String),
    });
  });

  it('refuses a route policy naming a permission this plugin never declared at all', async () => {
    const manifest = processManifest('fliks.a', ['upload'], [
      { method: 'GET', path: '/queue', policy: 'read:plugin:fliks.a:download' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toMatchObject({ ok: false, reason: 'invalid-route-policy' });
  });

  it('drops the declared permission set on forget, keeps it on unregister', async () => {
    const manifest = processManifest('fliks.a', ['download'], [
      { method: 'GET', path: '/queue', policy: 'read:plugin:fliks.a:download' },
    ]);
    const service = makeService();
    await service.register(makePackage(manifest));
    expect(service.declaredPermissionsFor('fliks.a').size).toBe(1);

    await service.unregister('fliks.a');
    expect(service.declaredPermissionsFor('fliks.a').size).toBe(1);

    await service.forget('fliks.a');
    expect(service.declaredPermissionsFor('fliks.a').size).toBe(0);
  });
});
