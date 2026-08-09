import { NotFoundException } from '@nestjs/common';
import { PluginSourcesController } from './plugin-sources.controller';
import { PluginSource } from './entities/plugin-source.entity';

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

describe('PluginSourcesController', () => {
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

  it('delegates a catalog install to the install service for a known source', async () => {
    const source = fakeSource();
    const repo = { findOne: jest.fn().mockResolvedValue(source) };
    const installService = { installFromCatalog: jest.fn().mockResolvedValue({ pluginId: 'fliks.test', version: '1.0.0', status: 'active' }) };
    const controller = new PluginSourcesController(repo as never, {} as never, installService as never);

    await expect(controller.install(1, { pluginId: 'fliks.test', version: '1.0.0' })).resolves.toEqual({
      pluginId: 'fliks.test',
      version: '1.0.0',
      status: 'active',
    });
    expect(installService.installFromCatalog).toHaveBeenCalledWith(source, 'fliks.test', '1.0.0');
  });

  it('404s a catalog install of an unknown source without touching the install service', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) };
    const installService = { installFromCatalog: jest.fn() };
    const controller = new PluginSourcesController(repo as never, {} as never, installService as never);

    await expect(controller.install(99, { pluginId: 'fliks.test', version: '1.0.0' })).rejects.toThrow(NotFoundException);
    expect(installService.installFromCatalog).not.toHaveBeenCalled();
  });
});
