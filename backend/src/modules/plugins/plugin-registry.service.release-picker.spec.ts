import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry } from './plugin-registry.test-helpers';
import type { PluginManifest, PluginRoute, ReleasePickerRoutes } from '../../common/plugin-contract';

const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

const ROUTES: PluginRoute[] = [
  { method: 'GET', path: '/movie/:id/releases', policy: 'read:Media' },
  { method: 'POST', path: '/movie/:id/grab', policy: 'grab:Media' },
  { method: 'GET', path: '/season/:id/:seasonId/releases', policy: 'read:Media' },
  { method: 'POST', path: '/season/:id/:seasonId/grab', policy: 'grab:Media' },
  { method: 'GET', path: '/episode/:id/:seasonId/:episodeId/releases', policy: 'read:Media' },
  { method: 'POST', path: '/episode/:id/:seasonId/:episodeId/grab', policy: 'grab:Media' },
];

const VALID_PICKER: ReleasePickerRoutes = {
  movie: { search: '/movie/:id/releases', grab: '/movie/:id/grab' },
  season: { search: '/season/:id/:seasonId/releases', grab: '/season/:id/:seasonId/grab' },
  episode: { search: '/episode/:id/:seasonId/:episodeId/releases', grab: '/episode/:id/:seasonId/:episodeId/grab' },
};

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
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

function processManifest(id: string, releasePicker: ReleasePickerRoutes | undefined, routes: PluginRoute[] = ROUTES) {
  return minimalProcessManifest(
    { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
    { id, fliks: COMPATIBLE_RANGE, routes, ui: releasePicker ? { releasePicker } : undefined },
  );
}

describe('PluginRegistryService — releasePicker registration validation', () => {
  it('refuses a releasePicker route that names a path routes[] never declares', async () => {
    const manifest = processManifest('fliks.a', {
      ...VALID_PICKER,
      movie: { ...VALID_PICKER.movie, search: '/movie/:id/upgrade-releases' },
    });
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-release-picker', detail: expect.any(String) });
  });

  it('refuses a releasePicker route declared with the wrong method (grab must be POST)', async () => {
    const manifest = processManifest(
      'fliks.a',
      { ...VALID_PICKER, movie: { ...VALID_PICKER.movie, grab: '/movie/:id/releases' } },
      ROUTES,
    );
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-release-picker', detail: expect.any(String) });
  });

  it('refuses a second installed plugin declaring a releasePicker while the first still holds one', async () => {
    const service = makeService();
    const first = processManifest('fliks.a', VALID_PICKER);
    await service.register(makePackage(first));

    const second = processManifest('fliks.b', VALID_PICKER);
    const result = await service.register(makePackage(second));

    expect(result).toEqual({ ok: false, pluginId: second.id, reason: 'release-picker-conflict', detail: expect.any(String) });
  });

  it('lets the same plugin re-register the releasePicker it already owns', async () => {
    const service = makeService();
    const manifest = processManifest('fliks.a', VALID_PICKER);
    await service.register(makePackage(manifest));

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
  });

  it('accepts a valid releasePicker and exposes it', async () => {
    const manifest = processManifest('fliks.a', VALID_PICKER);
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.releasePickerFor(manifest.id)).toEqual(VALID_PICKER);
  });

  it('drops the releasePicker on forget, so another plugin can then claim it', async () => {
    const service = makeService();
    const first = processManifest('fliks.a', VALID_PICKER);
    await service.register(makePackage(first));

    await service.forget(first.id);
    expect(service.releasePickerFor(first.id)).toBeUndefined();

    const second = processManifest('fliks.b', VALID_PICKER);
    const result = await service.register(makePackage(second));
    expect(result).toEqual({ ok: true, pluginId: second.id });
  });

  it('keeps the releasePicker claimed across unregister, so a stopped plugin still blocks another', async () => {
    const service = makeService();
    const first = processManifest('fliks.a', VALID_PICKER);
    await service.register(makePackage(first));

    await service.unregister(first.id);
    expect(service.releasePickerFor(first.id)).toEqual(VALID_PICKER);

    const second = processManifest('fliks.b', VALID_PICKER);
    const result = await service.register(makePackage(second));
    expect(result).toEqual({ ok: false, pluginId: second.id, reason: 'release-picker-conflict', detail: expect.any(String) });
  });
});
