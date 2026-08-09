import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalDataManifest } from './archive/test-manifests';
import { buildIndexerImplementationId, type IndexerDescriptor, type PluginManifest } from '../../common/plugin-contract';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    // Descriptor validation never re-verifies the archive (verifiedByKeyId is null), so its bytes don't matter.
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

function indexerDescriptor(overrides: Partial<IndexerDescriptor> = {}): IndexerDescriptor {
  return {
    key: 'mytracker',
    name: 'My Tracker',
    driverApi: 'torznab',
    endpoint: 'https://tracker.example/api',
    settings: [],
    ...overrides,
  };
}

describe('PluginRegistryService — indexer descriptors', () => {
  it('refuses a descriptor with an unsupported driverApi, naming the missing driver', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor({ driverApi: 'newznab' })] },
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'unsupported-indexer-driver',
      detail: expect.stringContaining('newznab'),
    });
    expect(service.getIndexerDescriptor(buildIndexerImplementationId(manifest.id, 'mytracker'))).toBeUndefined();
  });

  it('refuses a duplicate key within the same plugin', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor({ key: 'dup' }), indexerDescriptor({ key: 'dup' })] },
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-indexer-key',
      detail: expect.stringContaining('dup'),
    });
  });

  it('refuses a key containing the namespace separator', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor({ key: 'my.tracker' })] },
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-indexer-key',
      detail: expect.any(String),
    });
  });

  it('refuses a malformed endpoint', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor({ endpoint: 'not-a-url' })] },
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'invalid-indexer-endpoint',
      detail: expect.stringContaining('not-a-url'),
    });
  });

  it('registers a valid descriptor and exposes it under its namespaced id', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor()] },
    });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(makePackage(manifest));

    const implementationId = buildIndexerImplementationId(manifest.id, 'mytracker');
    expect(result).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.getIndexerDescriptor(implementationId)).toEqual(indexerDescriptor());
    expect(service.listIndexerDescriptors()).toEqual([
      { implementationId, pluginId: manifest.id, ...indexerDescriptor() },
    ]);
  });

  it('drops a plugin descriptors on unregister', async () => {
    const manifest = minimalDataManifest({
      fliks: COMPATIBLE_RANGE,
      provides: { indexers: [indexerDescriptor()] },
    });
    const service = new PluginRegistryService(repoMock() as never);
    await service.register(makePackage(manifest));
    const implementationId = buildIndexerImplementationId(manifest.id, 'mytracker');
    expect(service.getIndexerDescriptor(implementationId)).toBeDefined();

    service.unregister(manifest.id);

    expect(service.getIndexerDescriptor(implementationId)).toBeUndefined();
    expect(service.listIndexerDescriptors()).toEqual([]);
  });
});
