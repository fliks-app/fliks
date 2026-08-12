import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import {
  fakeRegistrationRepo,
  fakeProcessService,
  fakePluginJobsService,
  fakeScheduledJobRegistry,
} from './plugin-registry.test-helpers';
import type { PluginManifest, PluginRoute } from '../../common/plugin-contract';

const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function makePackage(
  manifest: PluginManifest,
  overrides: Partial<PluginPackage> = {},
): PluginPackage {
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

function processManifest(
  id: string,
  routes: PluginRoute[],
  legacyPaths?: Record<string, string>,
) {
  return minimalProcessManifest(
    { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
    { id, fliks: COMPATIBLE_RANGE, routes, legacyPaths },
  );
}

describe('PluginRegistryService — legacyPaths registration validation', () => {
  it('refuses an entry that is not "<METHOD> <path>"', async () => {
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        '/api/media/:id/releases': 'GET /:id/releases',
      },
    );
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-legacy-path',
      detail: expect.any(String),
    });
  });

  it('refuses a value that does not name a route declared in routes[]', async () => {
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /:id/upgrade-releases',
      },
    );
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-legacy-path',
      detail: expect.any(String),
    });
  });

  it('refuses a key/value pair that captures mismatched param names', async () => {
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:mediaId/releases': 'GET /:id/releases',
      },
    );
    const result = await makeService().register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-legacy-path',
      detail: expect.any(String),
    });
  });

  it('refuses a second installed plugin claiming a key the first already owns', async () => {
    const service = makeService();
    const first = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /:id/releases',
      },
    );
    await service.register(makePackage(first));

    const second = processManifest(
      'fliks.b',
      [{ method: 'GET', path: '/x/:id', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /x/:id',
      },
    );
    const result = await service.register(makePackage(second));

    expect(result).toEqual({
      ok: false,
      pluginId: second.id,
      reason: 'legacy-path-conflict',
      detail: expect.any(String),
    });
  });

  it('lets the same plugin re-register the alias it already owns', async () => {
    const service = makeService();
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /:id/releases',
      },
    );
    await service.register(makePackage(manifest));

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
  });

  it('accepts a valid legacyPaths declaration and resolves it to the target route and params', async () => {
    const manifest = processManifest(
      'fliks.a',
      [
        {
          method: 'GET',
          path: '/:id/seasons/:seasonId/releases',
          policy: 'read:Media',
        },
      ],
      {
        'GET /api/media/:id/seasons/:seasonId/releases':
          'GET /:id/seasons/:seasonId/releases',
      },
    );
    const service = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(
      service.resolveLegacyAlias('GET', '/api/media/7/seasons/3/releases'),
    ).toEqual({
      pluginId: manifest.id,
      targetPath: '/7/seasons/3/releases',
      resolved: {
        route: manifest.routes[0],
        params: { id: '7', seasonId: '3' },
      },
    });
    expect(
      service.resolveLegacyAlias('GET', '/api/media/7/releases'),
    ).toBeNull();
  });

  it('drops the alias table on forget, so it stops resolving', async () => {
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /:id/releases',
      },
    );
    const service = makeService();
    await service.register(makePackage(manifest));

    await service.forget(manifest.id);

    expect(
      service.resolveLegacyAlias('GET', '/api/media/7/releases'),
    ).toBeNull();
  });

  it('keeps the alias resolvable to its route across unregister, so a stopped plugin still resolves', async () => {
    const manifest = processManifest(
      'fliks.a',
      [{ method: 'GET', path: '/:id/releases', policy: 'read:Media' }],
      {
        'GET /api/media/:id/releases': 'GET /:id/releases',
      },
    );
    const service = makeService();
    await service.register(makePackage(manifest));

    await service.unregister(manifest.id);

    expect(
      service.resolveLegacyAlias('GET', '/api/media/7/releases'),
    ).not.toBeNull();
  });
});
