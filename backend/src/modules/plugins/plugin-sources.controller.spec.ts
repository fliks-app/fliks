import { NotFoundException } from '@nestjs/common';
import { PluginSourcesController } from './plugin-sources.controller';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginInstallException } from './plugin-install.exception';

function fakeSource(overrides: Partial<PluginSource> = {}): PluginSource {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    url: 'https://catalog.example.com/',
    enabled: true,
    publicKey: null,
    lastRefreshedAt: null,
    lastRefreshError: null,
    cachedCatalog: null,
    ...overrides,
  } as PluginSource;
}

function fakeRepo(rows: PluginSource[] = []) {
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn(async ({ where }: { where: Partial<PluginSource> }) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => (r as never)[k] === v)) ?? null,
    ),
    create: jest.fn((partial: Partial<PluginSource>) => ({ id: 99, createdAt: new Date(), updatedAt: new Date(), ...partial }) as PluginSource),
    save: jest.fn(async (row: PluginSource) => row),
    remove: jest.fn(async (row: PluginSource) => row),
  };
}

async function expectSourceError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginInstallException);
  expect((err as PluginInstallException).getStatus()).toBe(status);
  expect((err as PluginInstallException).code).toBe(code);
}

describe('PluginSourcesController', () => {
  describe('list', () => {
    it('reports the plugin count and the pinned-key boolean for every source', async () => {
      const withKey = fakeSource({
        id: 1,
        publicKey: Buffer.alloc(32, 7),
        cachedCatalog: { plugins: [{ id: 'a' }, { id: 'b' }] },
      });
      const withoutKey = fakeSource({ id: 2, publicKey: null, cachedCatalog: null });
      const repo = fakeRepo([withKey, withoutKey]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      const list = await controller.list();

      expect(list).toEqual([
        expect.objectContaining({ id: 1, hasPinnedKey: true, pluginCount: 2 }),
        expect.objectContaining({ id: 2, hasPinnedKey: false, pluginCount: 0 }),
      ]);
      expect(list[0]).not.toHaveProperty('publicKey');
    });
  });

  describe('create', () => {
    it('refuses a non-https url without touching the repository', async () => {
      const repo = fakeRepo();
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await expectSourceError(
        controller.create({ url: 'http://insecure.example.com/catalog.json' }),
        400,
        'PLUGIN_SOURCE_INSECURE_URL',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses a duplicate url', async () => {
      const existing = fakeSource({ url: 'https://catalog.example.com/catalog.json' });
      const repo = fakeRepo([existing]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await expectSourceError(
        controller.create({ url: 'https://catalog.example.com/catalog.json' }),
        409,
        'PLUGIN_SOURCE_DUPLICATE_URL',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses a public key that does not decode to 32 bytes', async () => {
      const repo = fakeRepo();
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await expectSourceError(
        controller.create({ url: 'https://catalog.example.com/catalog.json', publicKey: Buffer.from('too short').toString('base64') }),
        400,
        'PLUGIN_SOURCE_BAD_KEY',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('creates a source with a valid 32-byte key', async () => {
      const repo = fakeRepo();
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);
      const key = Buffer.alloc(32, 1);

      const result = await controller.create({ url: 'https://catalog.example.com/catalog.json', publicKey: key.toString('base64') });

      expect(result).toEqual(expect.objectContaining({ hasPinnedKey: true, enabled: true }));
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ publicKey: key }));
    });
  });

  describe('update', () => {
    it('toggles enabled without requiring the other fields', async () => {
      const source = fakeSource({ enabled: true });
      const repo = fakeRepo([source]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      const result = await controller.update(1, { enabled: false });

      expect(result.enabled).toBe(false);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });

    it('404s updating an unknown source', async () => {
      const repo = fakeRepo([]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await expect(controller.update(99, { enabled: false })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes a source that has a cached catalog', async () => {
      const source = fakeSource({ cachedCatalog: { plugins: [{ id: 'a' }] } });
      const repo = fakeRepo([source]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await controller.remove(1);

      expect(repo.remove).toHaveBeenCalledWith(source);
    });

    it('404s deleting an unknown source', async () => {
      const repo = fakeRepo([]);
      const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

      await expect(controller.remove(99)).rejects.toThrow(NotFoundException);
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  it('returns the cached catalog fields for a known source', async () => {
    const source = fakeSource({ cachedCatalog: { plugins: [] }, lastRefreshError: 'boom' });
    const repo = { findOne: jest.fn().mockResolvedValue(source) };
    const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

    await expect(controller.getCatalog(1)).resolves.toEqual({
      cachedCatalog: { plugins: [] },
      lastRefreshedAt: null,
      lastRefreshError: 'boom',
    });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('404s reading the catalog of an unknown source', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) };
    const controller = new PluginSourcesController(repo as never, {} as never, {} as never);

    await expect(controller.getCatalog(99)).rejects.toThrow(NotFoundException);
  });

  it('delegates a manual refresh to the catalog client for a known source', async () => {
    const source = fakeSource();
    const repo = { findOne: jest.fn().mockResolvedValue(source) };
    const catalogClient = { refreshSource: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new PluginSourcesController(repo as never, catalogClient as never, {} as never);

    await expect(controller.refresh(1)).resolves.toEqual({ ok: true });
    expect(catalogClient.refreshSource).toHaveBeenCalledWith(source);
  });

  it('404s a manual refresh of an unknown source without touching the catalog client', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) };
    const catalogClient = { refreshSource: jest.fn() };
    const controller = new PluginSourcesController(repo as never, catalogClient as never, {} as never);

    await expect(controller.refresh(99)).rejects.toThrow(NotFoundException);
    expect(catalogClient.refreshSource).not.toHaveBeenCalled();
  });

  it('delegates a catalog inspect to the install service for a known source', async () => {
    const source = fakeSource();
    const repo = { findOne: jest.fn().mockResolvedValue(source) };
    const installService = { inspectFromCatalog: jest.fn().mockResolvedValue({ installable: true, stagingId: 'abc', sha256: 'def' }) };
    const controller = new PluginSourcesController(repo as never, {} as never, installService as never);

    await expect(controller.inspect(1, { pluginId: 'fliks.test', version: '1.0.0' })).resolves.toEqual({
      installable: true,
      stagingId: 'abc',
      sha256: 'def',
    });
    expect(installService.inspectFromCatalog).toHaveBeenCalledWith(source, 'fliks.test', '1.0.0');
  });

  it('404s a catalog inspect of an unknown source without touching the install service', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) };
    const installService = { inspectFromCatalog: jest.fn() };
    const controller = new PluginSourcesController(repo as never, {} as never, installService as never);

    await expect(controller.inspect(99, { pluginId: 'fliks.test', version: '1.0.0' })).rejects.toThrow(NotFoundException);
    expect(installService.inspectFromCatalog).not.toHaveBeenCalled();
  });
});
