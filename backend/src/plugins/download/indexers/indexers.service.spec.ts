import { BadRequestException } from '@nestjs/common';
import { IndexersService } from './indexers.service';
import { Indexer } from './entities/indexer.entity';

function makeService() {
  const indexerRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: Partial<Indexer>) => Promise.resolve({ id: 1, ...x }) as unknown as Indexer),
    findOne: jest.fn(),
  };
  const torznab = { refreshCaps: jest.fn().mockResolvedValue(undefined), testConnection: jest.fn() };
  const throttle = {};
  const service = new IndexersService(indexerRepo as never, torznab as never, throttle as never);
  return { service, indexerRepo, torznab };
}

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
