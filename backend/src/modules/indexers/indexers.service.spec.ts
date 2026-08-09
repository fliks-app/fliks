import { BadRequestException } from '@nestjs/common';
import { IndexersService } from './indexers.service';
import { Indexer } from './entities/indexer.entity';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { buildIndexerImplementationId, type IndexerDescriptor } from '../../common/plugin-contract';

function makeService(getIndexerDescriptor: jest.Mock = jest.fn().mockReturnValue(undefined)) {
  const indexerRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: Partial<Indexer>) => Promise.resolve({ id: 1, ...x }) as unknown as Indexer),
    findOne: jest.fn(),
  };
  const torznab = { refreshCaps: jest.fn().mockResolvedValue(undefined), testConnection: jest.fn() };
  const throttle = {};
  const registry = { getIndexerDescriptor } as unknown as PluginRegistryService;
  const service = new IndexersService(
    indexerRepo as never,
    torznab as never,
    throttle as never,
    registry,
  );
  return { service, indexerRepo, torznab };
}

const descriptor: IndexerDescriptor = {
  key: 'mytracker',
  name: 'My Tracker',
  driverApi: 'torznab',
  endpoint: 'https://tracker.example/api',
  settings: [],
};

describe('IndexersService — implementation validation', () => {
  it('creates with the legacy "torznab" implementation', async () => {
    const { service } = makeService();

    const result = await service.create({
      name: 'X',
      implementation: 'torznab',
      settings: { baseUrl: 'https://x.tld', apiKey: 'k' },
    });

    expect(result.implementation).toBe('torznab');
  });

  it('creates with a currently registered descriptor id', async () => {
    const implementation = buildIndexerImplementationId('fliks.test-plugin', 'mytracker');
    const getIndexerDescriptor = jest.fn((id: string) => (id === implementation ? descriptor : undefined));
    const { service } = makeService(getIndexerDescriptor);

    const result = await service.create({
      name: 'X',
      implementation,
      settings: { apiKey: 'k' },
    });

    expect(result.implementation).toBe(implementation);
  });

  it('refuses an unregistered implementation, naming it', async () => {
    const { service } = makeService();
    const implementation = 'fliks.missing-plugin.tracker';

    await expect(
      service.create({ name: 'X', implementation, settings: {} }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ name: 'X', implementation, settings: {} }),
    ).rejects.toThrow(/fliks\.missing-plugin\.tracker/);
  });

  it('refuses an unregistered implementation on update, naming it', async () => {
    const { service, indexerRepo } = makeService();
    indexerRepo.findOne.mockResolvedValue({
      id: 1,
      name: 'X',
      implementation: 'torznab',
      settings: {},
    } as Indexer);

    await expect(
      service.update(1, { implementation: 'fliks.missing-plugin.tracker' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('updates to a currently registered descriptor id', async () => {
    const implementation = buildIndexerImplementationId('fliks.test-plugin', 'mytracker');
    const getIndexerDescriptor = jest.fn((id: string) => (id === implementation ? descriptor : undefined));
    const { service, indexerRepo } = makeService(getIndexerDescriptor);
    indexerRepo.findOne.mockResolvedValue({
      id: 1,
      name: 'X',
      implementation: 'torznab',
      settings: {},
    } as Indexer);

    const result = await service.update(1, { implementation });

    expect(result.implementation).toBe(implementation);
  });
});

describe('IndexersService — testConnection', () => {
  it('uses settings.baseUrl for the legacy "torznab" implementation', async () => {
    const { service, torznab } = makeService();
    torznab.testConnection.mockResolvedValue({ ok: true, message: 'ok' });

    await service.testConnection({
      implementation: 'torznab',
      settings: { baseUrl: 'https://x.tld', apiKey: 'k' },
    });

    expect(torznab.testConnection).toHaveBeenCalledWith('https://x.tld', 'k');
  });

  it('uses the descriptor endpoint for a registered descriptor id', async () => {
    const implementation = buildIndexerImplementationId('fliks.test-plugin', 'mytracker');
    const getIndexerDescriptor = jest.fn((id: string) => (id === implementation ? descriptor : undefined));
    const { service, torznab } = makeService(getIndexerDescriptor);
    torznab.testConnection.mockResolvedValue({ ok: true, message: 'ok' });

    await service.testConnection({ implementation, settings: { apiKey: 'k' } });

    expect(torznab.testConnection).toHaveBeenCalledWith(descriptor.endpoint, 'k');
  });

  it('reports failure, naming it, for an unregistered implementation', async () => {
    const { service, torznab } = makeService();

    const result = await service.testConnection({
      implementation: 'fliks.missing-plugin.tracker',
      settings: {},
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('fliks.missing-plugin.tracker');
    expect(torznab.testConnection).not.toHaveBeenCalled();
  });
});
