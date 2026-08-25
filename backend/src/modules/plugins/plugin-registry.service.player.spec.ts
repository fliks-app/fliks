import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry, fakeCountsCache } from './plugin-registry.test-helpers';
import type { PluginManifest, PluginRoute, PlayerDeclaration } from '../../common/plugin-contract';

const COMPATIBLE_RANGE = '>=1.0.0';

const ROUTES: PluginRoute[] = [{ method: 'POST', path: '/pre-roll', policy: 'read:Media' }];

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
    { find: jest.fn().mockResolvedValue([]) } as never,
    fakeRegistrationRepo() as never,
    fakeProcessService() as never,
    fakePluginJobsService() as never,
    fakeScheduledJobRegistry() as never,
    fakeCountsCache() as never,
  );
}

function processManifest(id: string, player: PlayerDeclaration | undefined, routes: PluginRoute[] = ROUTES) {
  return minimalProcessManifest(
    { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
    { id, fliks: COMPATIBLE_RANGE, routes, ui: player ? { player } : undefined },
  );
}

describe('PluginRegistryService — ui.player registration validation', () => {
  it('refuses a preRollRoute that is not one of the manifest\'s own POST routes', async () => {
    const manifest = processManifest('fliks.a', { preRollRoute: '/not-declared' });
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-player', detail: expect.any(String) });
  });

  it('refuses a preRollRoute declared with a method other than POST', async () => {
    const manifest = processManifest('fliks.a', { preRollRoute: '/pre-roll' }, [
      { method: 'GET', path: '/pre-roll', policy: 'read:Media' },
    ]);
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: manifest.id, reason: 'invalid-player', detail: expect.any(String) });
  });

  it('accepts a valid preRollRoute and exposes the winner', async () => {
    const manifest = processManifest('fliks.a', { preRollRoute: '/pre-roll' });
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.preRollRoute()).toEqual({ pluginId: 'fliks.a', route: '/pre-roll' });
  });

  it('resolves the winner by lexicographically smallest plugin id, and logs the loser', async () => {
    const service = makeService();
    await service.register(makePackage(processManifest('fliks.zebra', { preRollRoute: '/pre-roll' })));
    await service.register(makePackage(processManifest('fliks.alpha', { preRollRoute: '/pre-roll' })));

    // The loser keeps every other route it declared; only the pre-roll slot is exclusive.
    expect(service.preRollRoute()).toEqual({ pluginId: 'fliks.alpha', route: '/pre-roll' });
    expect(service.resolveRoute('fliks.zebra', 'POST', '/pre-roll')).not.toBeNull();
  });
});
