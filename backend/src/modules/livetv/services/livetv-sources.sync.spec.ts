import { LiveTvSourcesService } from './livetv-sources.service';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { liveTvGet } from '../livetv-http';

jest.mock('../livetv-http', () => {
  const actual = jest.requireActual('../livetv-http');
  return { ...actual, liveTvGet: jest.fn() };
});
const mockedLiveTvGet = liveTvGet as jest.Mock;

/** Chainable TypeORM query-builder stand-in; every method returns itself. */
function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'delete', 'innerJoin', 'where', 'andWhere', 'groupBy']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return Object.assign(qb, overrides);
}

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Test',
    kind: 'm3u',
    url: 'http://provider/playlist.m3u',
    username: null,
    password: null,
    userAgent: null,
    referer: null,
    maxStreams: 0,
    maxStreamsIsManual: false,
    includeGroupsPattern: null,
    excludeGroupsPattern: null,
    channelCount: 0,
    guideUrls: [],
    playlistEtag: null,
    playlistLastModified: null,
    expiresAt: null,
    accountStatus: null,
    ...overrides,
  };
}

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    channelId: 1,
    externalId: 'x',
    url: 'http://old',
    lastSeenAt: null,
    ...overrides,
  };
}

function setup(sourceOverrides: Record<string, unknown> = {}) {
  const source = makeSource(sourceOverrides);
  let nextChannelId = 100;

  const sourceRepo = {
    findOne: jest.fn().mockResolvedValue(source),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const channelRepo = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((x) => x),
    save: jest.fn(async (rows: Array<Record<string, unknown>>) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      return arr.map((r) => ({ id: r.id ?? nextChannelId++, ...r }));
    }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
  const streamRepo = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((x) => x),
    save: jest.fn(async (rows: Array<Record<string, unknown>>) => rows),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (manager: unknown) => unknown) =>
      cb({
        getRepository: (entity: unknown) =>
          entity === LiveTvChannel ? channelRepo : streamRepo,
      }),
    ),
  };
  const settings = { get: jest.fn().mockResolvedValue(null) };
  const logos = { cacheLogos: jest.fn().mockResolvedValue(undefined) };
  const access = { restrictAdultGroups: jest.fn().mockResolvedValue([]) };

  const service = new LiveTvSourcesService(
    sourceRepo as never,
    channelRepo as never,
    streamRepo as never,
    dataSource as never,
    settings as never,
    logos as never,
    access as never,
  );

  return { service, source, sourceRepo, channelRepo, streamRepo, settings, logos, access };
}

describe('LiveTvSourcesService.sync (m3u)', () => {
  afterEach(() => jest.resetAllMocks());

  it('records a no-op success on a 304 and touches nothing else', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 304, data: '', headers: {} });
    const { service, sourceRepo, channelRepo, streamRepo } = setup({
      playlistEtag: '"abc"',
      channelCount: 3,
    });

    const result = await service.sync(1);

    expect(result).toEqual({ ok: true, added: 0, updated: 0, removed: 0, channelCount: 3 });
    expect(sourceRepo.update).toHaveBeenCalledWith(1, {
      lastSyncAt: expect.any(Date),
      lastSyncStatus: 'ok',
      lastSyncError: null,
    });
    expect(channelRepo.save).not.toHaveBeenCalled();
    expect(streamRepo.save).not.toHaveBeenCalled();
  });

  it('carries per-entry headers onto the new stream and captures guide/account state', async () => {
    const playlist = [
      '#EXTM3U x-tvg-url="http://g/1,http://g/2" max-conn="4" billed-till="2029-01-01"',
      '#EXTINF:-1 group-title="News",One',
      '#EXTVLCOPT:http-user-agent=Custom/1.0',
      '#EXTVLCOPT:http-referrer=http://portal/',
      'http://provider/live/1.ts',
    ].join('\n');
    mockedLiveTvGet.mockResolvedValue({
      status: 200,
      data: playlist,
      headers: { etag: '"v2"', 'last-modified': 'Tue, 01 Jan 2029 00:00:00 GMT' },
    });
    const { service, sourceRepo, streamRepo } = setup();

    const result = await service.sync(1);

    expect(result.ok).toBe(true);
    expect(result.added).toBe(1);
    expect(streamRepo.save).toHaveBeenCalledWith(
      [expect.objectContaining({ userAgent: 'Custom/1.0', referer: 'http://portal/' })],
      expect.anything(),
    );
    expect(sourceRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        guideUrls: ['http://g/1', 'http://g/2'],
        playlistEtag: '"v2"',
        playlistLastModified: 'Tue, 01 Jan 2029 00:00:00 GMT',
        expiresAt: new Date('2029-01-01'),
        maxStreams: 4,
      }),
    );
  });

  it('never overwrites a maxStreams the admin set by hand', async () => {
    const playlist = '#EXTM3U max-conn="4"\n#EXTINF:-1,One\nhttp://provider/live/1.ts\n';
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: playlist, headers: {} });
    const { service, sourceRepo } = setup({ maxStreamsIsManual: true, maxStreams: 99 });

    await service.sync(1);

    expect(sourceRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ maxStreams: 99 }),
    );
  });

  it('deletes a stream only once it has been unseen past the stale-days window', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: '#EXTM3U\n', headers: {} });
    const recentlySeen = makeStream({
      id: 10,
      channelId: 1,
      externalId: 'recent',
      lastSeenAt: new Date(Date.now() - 1 * 86_400_000),
    });
    const staleUnseen = makeStream({
      id: 11,
      channelId: 2,
      externalId: 'stale',
      lastSeenAt: new Date(Date.now() - 10 * 86_400_000),
    });
    const { service, streamRepo, settings } = setup({ channelCount: 0 });
    settings.get.mockResolvedValue('7');
    streamRepo.find.mockResolvedValue([recentlySeen, staleUnseen]);

    const result = await service.sync(1);

    expect(result.removed).toBe(1);
    expect(streamRepo.delete).toHaveBeenCalledWith([11]);
  });

  it('applies the source include/exclude group patterns before importing', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="News",One',
      'http://provider/live/1.ts',
      '#EXTINF:-1 group-title="News Adult",Two',
      'http://provider/live/2.ts',
    ].join('\n');
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: playlist, headers: {} });
    const { service, streamRepo } = setup({
      includeGroupsPattern: 'news',
      excludeGroupsPattern: 'adult',
    });

    const result = await service.sync(1);

    expect(result.added).toBe(1);
    expect(streamRepo.save).toHaveBeenCalledWith(
      [expect.objectContaining({ externalId: '1' })],
      expect.anything(),
    );
  });

  it('reports every distinct live group to the adult-group restriction pass', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="News",One',
      'http://provider/live/1.ts',
      '#EXTINF:-1 group-title="XXX Adult",Two',
      'http://provider/live/2.ts',
    ].join('\n');
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: playlist, headers: {} });
    const { service, access } = setup();

    await service.sync(1);

    expect(access.restrictAdultGroups).toHaveBeenCalledWith(
      expect.arrayContaining(['News', 'XXX Adult']),
    );
  });
});
