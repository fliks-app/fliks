import { DownloadClientsService } from './download-clients.service';
import { DownloadClient } from './entities/download-client.entity';

function makeService() {
  const repo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: Partial<DownloadClient>) => Promise.resolve({ id: 1, ...x }) as unknown as DownloadClient),
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const historyRepo = {};
  const stalledCheckRepo = {};
  const cleanupProfileRepo = {};
  const qbittorrent = {};
  const historyMatcher = {};
  const blocklist = {};
  const events = {};
  const service = new DownloadClientsService(
    repo as never,
    historyRepo as never,
    stalledCheckRepo as never,
    cleanupProfileRepo as never,
    qbittorrent as never,
    historyMatcher as never,
    blocklist as never,
    events as never,
  );
  return { service, repo };
}

describe('DownloadClientsService — password redaction on read', () => {
  it('strips the password from create()', async () => {
    const { service } = makeService();
    const result = await service.create({
      name: 'X',
      implementation: 'qbittorrent',
      settings: { host: 'h', password: 'secret' },
    });
    expect(result.settings).toEqual({ host: 'h' });
  });

  it('strips the password from every row in findAll()', async () => {
    const { service, repo } = makeService();
    repo.find.mockResolvedValue([
      { id: 1, settings: { host: 'a', password: 'p1' } },
      { id: 2, settings: { host: 'b', password: 'p2' } },
    ]);
    const rows = await service.findAll();
    expect(rows.map((r) => r.settings)).toEqual([{ host: 'a' }, { host: 'b' }]);
  });

  it('does not redact findOne() — the controller redacts before it reaches HTTP', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue({ id: 1, settings: { password: 'secret' } });
    const result = await service.findOne(1);
    expect(result.settings).toEqual({ password: 'secret' });
  });
});

describe('DownloadClientsService — password kept when the incoming one is blank', () => {
  it('keeps the stored password when the update omits it', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue({
      id: 1,
      name: 'X',
      implementation: 'qbittorrent',
      settings: { host: 'h', password: 'stored' },
    });
    const result = await service.update(1, { settings: { host: 'h2' } });
    expect(result.settings).toEqual({ host: 'h2' });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { host: 'h2', password: 'stored' } }),
    );
  });

  it('overwrites the stored password when the update sends a non-empty one', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue({
      id: 1,
      name: 'X',
      implementation: 'qbittorrent',
      settings: { host: 'h', password: 'stored' },
    });
    await service.update(1, { settings: { host: 'h', password: 'new' } });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { host: 'h', password: 'new' } }),
    );
  });
});
