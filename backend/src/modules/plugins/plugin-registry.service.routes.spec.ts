import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry } from './plugin-registry.test-helpers';
import type { PluginManifest, PluginRoute } from '../../common/plugin-contract';
import type { PluginProcessStartResult } from './plugin-process.service';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    // Route validation runs before any archive materialisation — bytes never matter here.
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

function makeService(startResult?: PluginProcessStartResult): PluginRegistryService {
  return new PluginRegistryService(
    repoMock() as never,
    fakeRegistrationRepo() as never,
    fakeProcessService(startResult) as never,
    fakePluginJobsService() as never,
    fakeScheduledJobRegistry() as never,
  );
}

function processManifest(routes: PluginRoute[]) {
  return minimalProcessManifest({ 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) }, { fliks: COMPATIBLE_RANGE, routes });
}

describe('PluginRegistryService — route registration validation', () => {
  it('refuses a route with an unknown HTTP method', async () => {
    const manifest = processManifest([{ method: 'FETCH', path: '/queue', policy: 'read:Media' }]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-method', detail: expect.any(String) });
  });

  it('refuses a route whose path does not start with "/"', async () => {
    const manifest = processManifest([{ method: 'GET', path: 'queue', policy: 'read:Media' }]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-path', detail: expect.any(String) });
  });

  it('refuses a route whose path path-to-regexp cannot compile', async () => {
    const manifest = processManifest([{ method: 'GET', path: '/queue/:', policy: 'read:Media' }]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-path', detail: expect.any(String) });
  });

  it('refuses a route whose policy the closed vocabulary does not accept', async () => {
    const manifest = processManifest([{ method: 'GET', path: '/queue', policy: 'read:download' }]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-policy', detail: expect.any(String) });
  });

  it('refuses an objectGuard naming a param the path does not declare', async () => {
    const manifest = processManifest([
      { method: 'GET', path: '/queue', policy: 'read:Media', objectGuard: 'mediaAccessible:id' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-object-guard', detail: expect.any(String) });
  });

  it('refuses an objectGuard that does not resolve to one of the two known guards', async () => {
    const manifest = processManifest([
      { method: 'GET', path: '/releases/:id', policy: 'read:Media', objectGuard: 'deleteEverything:id' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-route-object-guard', detail: expect.any(String) });
  });

  it('refuses two routes sharing the same method and path', async () => {
    const manifest = processManifest([
      { method: 'GET', path: '/queue', policy: 'read:Media' },
      { method: 'get', path: '/queue', policy: 'manage:Settings' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'duplicate-route', detail: expect.any(String) });
  });

  it('accepts a manifest whose routes all validate, and resolves them afterwards', async () => {
    const manifest = processManifest([
      { method: 'GET', path: '/queue', policy: 'read:Media' },
      { method: 'GET', path: '/releases/:id', policy: 'grab:Media', objectGuard: 'mediaAccessible:id' },
    ]);
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.resolveRoute(manifest.id, 'GET', '/queue')).toEqual({
      route: manifest.routes[0],
      params: {},
    });
    expect(service.resolveRoute(manifest.id, 'POST', '/queue')).toBeNull();
  });

  it('keeps the route table on unregister, so a stopped plugin is unavailable rather than forbidden', async () => {
    const manifest = processManifest([{ method: 'GET', path: '/queue', policy: 'read:Media' }]);
    const service = makeService();
    await service.register(makePackage(manifest));

    await service.unregister(manifest.id);

    expect(service.resolveRoute(manifest.id, 'GET', '/queue')).not.toBeNull();
    expect(service.get(manifest.id)).toBeUndefined();
  });

  it('drops the route table on forget, which is what uninstall calls', async () => {
    const manifest = processManifest([{ method: 'GET', path: '/queue', policy: 'read:Media' }]);
    const service = makeService();
    await service.register(makePackage(manifest));

    await service.forget(manifest.id);

    expect(service.resolveRoute(manifest.id, 'GET', '/queue')).toBeNull();
  });

  it('keeps the routes resolvable when activation fails, but drops them when the manifest is unusable', async () => {
    const service = makeService({ ok: false, reason: 'spawn-failed', detail: 'boom' });
    const spawnable = processManifest([{ method: 'GET', path: '/queue', policy: 'read:Media' }]);

    const failed = await service.register(makePackage(spawnable));

    expect(failed).toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(service.resolveRoute(spawnable.id, 'GET', '/queue')).not.toBeNull();

    const unusable = processManifest([{ method: 'GET', path: '/queue', policy: 'read:NoSuchSubject' }]);
    const refused = await makeService().register(makePackage(unusable));

    expect(refused).toMatchObject({ ok: false, reason: 'invalid-route-policy' });
  });

  it('rebuilds the route table on re-registration rather than merging with the old one', async () => {
    const service = makeService();
    const first = processManifest([{ method: 'GET', path: '/queue', policy: 'read:Media' }]);
    await service.register(makePackage(first));

    const second = processManifest([{ method: 'GET', path: '/releases/:id', policy: 'grab:Media' }]);
    await service.register(makePackage({ ...second, id: first.id } as never));

    expect(service.resolveRoute(first.id, 'GET', '/queue')).toBeNull();
    expect(service.resolveRoute(first.id, 'GET', '/releases/42')).not.toBeNull();
  });

  it('leaves no route table behind for a plugin that fails an unrelated, earlier registration check', async () => {
    const manifest = processManifest([{ method: 'GET', path: '/queue', policy: 'read:Media' }]);
    manifest.fliks = '>=99.0.0'; // incompatible on purpose — fails before route validation even runs
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result.ok).toBe(false);
    expect(service.resolveRoute(manifest.id, 'GET', '/queue')).toBeNull();
  });
});
