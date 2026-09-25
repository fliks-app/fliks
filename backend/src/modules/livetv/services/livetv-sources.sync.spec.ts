import { ConflictException } from '@nestjs/common';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  LiveTvSourcesService,
  liveTvAccountStateOf,
  LIVETV_EXPIRY_WARNING_DAYS,
} from './livetv-sources.service';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { LiveTvSource } from '../entities/livetv-source.entity';
import { assertNotInternal, liveTvGet } from '../livetv-http';
import type { TestLiveTvSourceDto } from '../dto/test-livetv-source.dto';
import { UpdateLiveTvSourceDto } from '../dto/update-livetv-source.dto';

jest.mock('../livetv-http', () => {
  const actual = jest.requireActual('../livetv-http');
  return { ...actual, liveTvGet: jest.fn(), assertNotInternal: jest.fn() };
});
const mockedLiveTvGet = liveTvGet as jest.Mock;
const mockedAssertNotInternal = assertNotInternal as jest.Mock;

/** Chainable TypeORM query-builder stand-in; every method returns itself. */
function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'delete', 'innerJoin', 'where', 'andWhere', 'groupBy', 'whereInIds']) {
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
    expiresAt: null as Date | null,
    accountStatus: null as string | null,
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

  /** Stands in for the real `findOne` query builder: `getOne` is the only
   *  thing that needs to resolve, but `addSelect`/`where` stay spy-able so a
   *  test can assert the password column was explicitly re-requested. */
  const sourceQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(source),
  };
  const sourceRepo = {
    createQueryBuilder: jest.fn(() => sourceQueryBuilder),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn(async (row: unknown) => row),
    remove: jest.fn(async (row: unknown) => row),
    // Empty by default: the vanished-group sweep's gate then finds nothing
    // enabled and stays closed, so most tests never touch it.
    find: jest.fn().mockResolvedValue([]),
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
  // Backs the raw `groupNameSource` lookup in `upsert`: no channel is
  // admin-overridden unless a test says so.
  const managerQuery = jest.fn().mockResolvedValue([]);
  const dataSource = {
    transaction: jest.fn(async (cb: (manager: unknown) => unknown) =>
      cb({
        getRepository: (entity: unknown) =>
          entity === LiveTvChannel ? channelRepo : entity === LiveTvSource ? sourceRepo : streamRepo,
        query: managerQuery,
      }),
    ),
  };
  const settings = { get: jest.fn().mockResolvedValue(null) };
  const logos = { cacheLogos: jest.fn().mockResolvedValue(undefined) };
  const access = {
    restrictAdultGroups: jest.fn().mockResolvedValue([]),
    expireVanishedGroups: jest.fn().mockResolvedValue([]),
  };
  const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const activityRegistry = {
    has: jest.fn().mockReturnValue(false),
    upsertRunning: jest.fn(),
    remove: jest.fn(),
  };

  const service = new LiveTvSourcesService(
    sourceRepo as never,
    channelRepo as never,
    streamRepo as never,
    dataSource as never,
    settings as never,
    logos as never,
    access as never,
    notifications as never,
    activityRegistry as never,
  );

  return {
    service,
    source,
    sourceRepo,
    sourceQueryBuilder,
    channelRepo,
    streamRepo,
    managerQuery,
    settings,
    logos,
    access,
    notifications,
    activityRegistry,
  };
}

describe('LiveTvSourcesService.sync (m3u)', () => {
  afterEach(() => jest.resetAllMocks());

  // The hourly cron and an admin's manual sync both come through here.
  it('refuses a source another run already holds, and releases it after', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 304, data: '', headers: {} });
    const { service, activityRegistry } = setup({ playlistEtag: '"abc"', channelCount: 3 });

    activityRegistry.has.mockReturnValueOnce(true);
    await expect(service.sync(1)).rejects.toThrow(ConflictException);
    expect(activityRegistry.upsertRunning).not.toHaveBeenCalled();

    activityRegistry.has.mockReturnValue(false);
    await service.sync(1);
    expect(activityRegistry.upsertRunning).toHaveBeenCalledWith(
      'LiveTvSourceSync:1',
      'LiveTvSourceSync',
    );
    expect(activityRegistry.remove).toHaveBeenCalledWith('LiveTvSourceSync:1');
  });

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

  describe('a failing adult-group restriction pass', () => {
    const playlist =
      '#EXTM3U\n#EXTINF:-1 group-title="XXX Adult",One\nhttp://provider/live/1.ts\n';

    it('still returns a successful sync and leaves lastSyncStatus at "ok"', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: playlist,
        headers: {},
      });
      const { service, sourceRepo, access } = setup();
      access.restrictAdultGroups.mockRejectedValue(
        new Error('connection terminated'),
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const result = await service.sync(1);

      expect(result.ok).toBe(true);
      expect(sourceRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ lastSyncStatus: 'ok', lastSyncError: null }),
      );
    });

    it('logs at error level and records the failure on lastAdultGuardError, apart from lastSyncError', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: playlist,
        headers: {},
      });
      const { service, sourceRepo, access } = setup();
      access.restrictAdultGroups.mockRejectedValue(
        new Error('connection terminated'),
      );
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await service.sync(1);

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('connection terminated'),
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Adult-group'),
      );
      expect(sourceRepo.update).toHaveBeenCalledWith(1, {
        lastAdultGuardError: 'connection terminated',
      });
    });

    it('dispatches livetv.adult_guard_failed', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: playlist,
        headers: {},
      });
      const { service, access, notifications } = setup();
      access.restrictAdultGroups.mockRejectedValue(
        new Error('connection terminated'),
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.sync(1);

      expect(notifications.dispatch).toHaveBeenCalledWith(
        'livetv.adult_guard_failed',
        expect.objectContaining({ sourceName: 'Test' }),
      );
    });

    it('never writes lastAdultGuardError when the pass already succeeds', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: playlist,
        headers: {},
      });
      const { service, sourceRepo, access } = setup();
      access.restrictAdultGroups.mockResolvedValue([]);

      await service.sync(1);

      expect(sourceRepo.update).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ lastAdultGuardError: expect.anything() }),
      );
    });

    it('clears a previous lastAdultGuardError once the pass succeeds again', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: playlist,
        headers: {},
      });
      const { service, sourceRepo, access } = setup({
        lastAdultGuardError: 'connection terminated',
      });
      access.restrictAdultGroups.mockResolvedValue([]);

      await service.sync(1);

      expect(sourceRepo.update).toHaveBeenCalledWith(1, {
        lastAdultGuardError: null,
      });
    });
  });

  describe('group realignment on an existing channel', () => {
    function existingChannelFixture(overrides: Record<string, unknown> = {}) {
      return {
        id: 100,
        name: 'One',
        groupName: 'Sport',
        guideChannelId: null,
        streams: [{ id: 1, channelId: 100, sourceId: 1, externalId: 'x' }],
        ...overrides,
      };
    }
    const movedPlaylist = [
      '#EXTINF:-1 group-title="XXX Adult",One',
      'http://provider/live/u/p/x.ts',
    ].join('\n');

    it("follows the channel when the provider moves it into a new category", async () => {
      mockedLiveTvGet.mockResolvedValue({ status: 200, data: movedPlaylist, headers: {} });
      const { service, channelRepo, streamRepo, managerQuery } = setup();
      channelRepo.find.mockResolvedValue([existingChannelFixture()]);
      streamRepo.find.mockResolvedValue([
        makeStream({ id: 1, channelId: 100, externalId: 'x', lastSeenAt: new Date() }),
      ]);
      managerQuery.mockResolvedValue([{ id: 100, groupNameSource: 'provider' }]);

      await service.sync(1);

      expect(channelRepo.save).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 100, groupName: 'XXX Adult' })],
        expect.anything(),
      );
    });

    it('never overwrites a group the admin retitled by hand', async () => {
      mockedLiveTvGet.mockResolvedValue({ status: 200, data: movedPlaylist, headers: {} });
      const { service, channelRepo, streamRepo, managerQuery } = setup();
      const channel = existingChannelFixture({ groupName: 'My Sports' });
      channelRepo.find.mockResolvedValue([channel]);
      streamRepo.find.mockResolvedValue([
        makeStream({ id: 1, channelId: 100, externalId: 'x', lastSeenAt: new Date() }),
      ]);
      managerQuery.mockResolvedValue([{ id: 100, groupNameSource: 'manual' }]);

      await service.sync(1);

      expect(channelRepo.save).not.toHaveBeenCalled();
      expect(channel.groupName).toBe('My Sports');
    });
  });

  describe('liveGroupNames (feeding the vanished-group sweep)', () => {
    it("counts a disabled source's channels as still present, since the user-facing lineup never checks source.enabled", async () => {
      const { service, channelRepo } = setup();
      const qb = makeQueryBuilder();
      channelRepo.createQueryBuilder.mockReturnValue(qb);

      await (service as unknown as { liveGroupNames(): Promise<string[]> }).liveGroupNames();

      const whereArg = qb.where.mock.calls[0][0] as string;
      expect(whereArg).not.toMatch(/enabled/);
    });
  });

  describe('vanished-group sweep gate', () => {
    const okPlaylist =
      '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://provider/live/1.ts\n';

    it('sweeps once every enabled source last synced ok', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: okPlaylist,
        headers: {},
      });
      const { service, source, sourceRepo, access } = setup();
      sourceRepo.find.mockResolvedValue([
        { ...source, enabled: true, lastSyncStatus: 'ok' },
      ]);

      await service.sync(1);

      expect(access.expireVanishedGroups).toHaveBeenCalledTimes(1);
    });

    it('never sweeps while another enabled source is still in error', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: okPlaylist,
        headers: {},
      });
      const { service, source, sourceRepo, access } = setup();
      sourceRepo.find.mockResolvedValue([
        { ...source, id: 1, enabled: true, lastSyncStatus: 'ok' },
        { ...source, id: 2, enabled: true, lastSyncStatus: 'error' },
      ]);

      await service.sync(1);

      expect(access.expireVanishedGroups).not.toHaveBeenCalled();
    });

    it('never sweeps when no source is enabled at all', async () => {
      mockedLiveTvGet.mockResolvedValue({
        status: 200,
        data: okPlaylist,
        headers: {},
      });
      const { service, sourceRepo, access } = setup();
      sourceRepo.find.mockResolvedValue([]);

      await service.sync(1);

      expect(access.expireVanishedGroups).not.toHaveBeenCalled();
    });

    it('also sweeps on a 304, since a stale enabled source needs no new fetch to matter', async () => {
      mockedLiveTvGet.mockResolvedValue({ status: 304, data: '', headers: {} });
      const { service, source, sourceRepo, access } = setup({
        playlistEtag: '"abc"',
      });
      sourceRepo.find.mockResolvedValue([
        { ...source, enabled: true, lastSyncStatus: 'ok' },
      ]);

      await service.sync(1);

      expect(access.expireVanishedGroups).toHaveBeenCalledTimes(1);
    });
  });

  it('re-requests the password column explicitly, since the entity marks it select:false', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 304, data: '', headers: {} });
    const { service, sourceQueryBuilder } = setup();

    await service.sync(1);

    // Proves the code takes the addSelect path; TypeORM actually honouring
    // select:false + addSelect against a real column is the library's own
    // documented contract, not something this mock can exercise.
    expect(sourceQueryBuilder.addSelect).toHaveBeenCalledWith('source.password');
    expect(sourceQueryBuilder.getOne).toHaveBeenCalled();
  });

  it('dispatches livetv.account_expired once on the transition, then stays silent while still expired', async () => {
    const playlist = '#EXTM3U billed-till="2000-01-01"\n#EXTINF:-1,One\nhttp://provider/live/1.ts\n';
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: playlist, headers: {} });
    const { service, source, notifications } = setup();

    await service.sync(1);

    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(notifications.dispatch).toHaveBeenCalledWith(
      'livetv.account_expired',
      expect.objectContaining({ sourceName: 'Test' }),
    );

    // The real sync() reloads the source from the DB, so the second call has
    // to see what the first one actually persisted, not the object as it was
    // before the write.
    source.expiresAt = new Date('2000-01-01');
    notifications.dispatch.mockClear();

    await service.sync(1);

    expect(notifications.dispatch).not.toHaveBeenCalled();
  });

  it('re-arms the notification after the account goes back to valid and later nears expiry again', async () => {
    const { service, source, notifications } = setup({ expiresAt: new Date('2000-01-01') });

    const healthy = '#EXTM3U billed-till="2099-01-01"\n#EXTINF:-1,One\nhttp://provider/live/1.ts\n';
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: healthy, headers: {} });
    await service.sync(1);

    expect(notifications.dispatch).not.toHaveBeenCalled();

    source.expiresAt = new Date('2099-01-01');
    notifications.dispatch.mockClear();

    const soonIso = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const soon = `#EXTM3U billed-till="${soonIso}"\n#EXTINF:-1,One\nhttp://provider/live/1.ts\n`;
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: soon, headers: {} });
    await service.sync(1);

    expect(notifications.dispatch).toHaveBeenCalledWith(
      'livetv.account_expiring',
      expect.objectContaining({ sourceName: 'Test' }),
    );
  });
});

describe('liveTvAccountStateOf', () => {
  it('reads "expired" off accountStatus case-insensitively, regardless of the date', () => {
    expect(liveTvAccountStateOf(new Date('2099-01-01'), 'EXPIRED')).toBe('expired');
    expect(liveTvAccountStateOf(null, 'expired')).toBe('expired');
  });

  it('treats a null expiresAt as ok when the status says nothing is wrong', () => {
    expect(liveTvAccountStateOf(null, null)).toBe('ok');
    expect(liveTvAccountStateOf(null, 'Active')).toBe('ok');
  });

  it('flags a past expiresAt as expired even with no accountStatus at all (the m3u case)', () => {
    expect(liveTvAccountStateOf(new Date(Date.now() - 1000), null)).toBe('expired');
  });

  it('flags the warning window but not a day further out', () => {
    const now = new Date('2030-06-01T00:00:00Z');
    const inWindow = new Date(now.getTime() + (LIVETV_EXPIRY_WARNING_DAYS - 1) * 86_400_000);
    const beyond = new Date(now.getTime() + (LIVETV_EXPIRY_WARNING_DAYS + 1) * 86_400_000);
    expect(liveTvAccountStateOf(inWindow, null, now)).toBe('expiring');
    expect(liveTvAccountStateOf(beyond, null, now)).toBe('ok');
  });
});

describe('LiveTvSourcesService.test (SSRF guard placement)', () => {
  afterEach(() => jest.resetAllMocks());

  it('refuses to probe a source whose address resolves inside the network', async () => {
    mockedAssertNotInternal.mockRejectedValue(
      new Error('Refused: "x" resolves to an internal address (169.254.169.254)'),
    );
    const { service } = setup();
    const dto = { kind: 'm3u', url: 'http://x/playlist.m3u' } as TestLiveTvSourceDto;

    const result = await service.test(dto);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/internal address/);
    expect(mockedLiveTvGet).not.toHaveBeenCalled();
  });

  it('never guards a registered source refresh, so a LAN provider keeps syncing', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: '#EXTM3U\n', headers: {} });
    const { service } = setup({ url: 'http://192.168.1.50/playlist.m3u' });

    const result = await service.sync(1);

    expect(result.ok).toBe(true);
    expect(mockedAssertNotInternal).not.toHaveBeenCalled();
  });
});

describe('LiveTvSourcesService.resolveGuideUrl', () => {
  afterEach(() => jest.resetAllMocks());

  it('reloads the source by id, so an xtream guide link carries the real password', async () => {
    const { service, sourceRepo } = setup({
      kind: 'xtream',
      url: 'http://panel.example',
      username: 'joe',
      password: 's3cret',
    });

    const url = await service.resolveGuideUrl(1);

    // A `LiveTvGuideSource.source` relation load never carries the select:false
    // password column either; only a fresh `findOne` does.
    expect(sourceRepo.createQueryBuilder).toHaveBeenCalled();
    expect(url).toBe('http://panel.example/xmltv.php?username=joe&password=s3cret');
  });
});

describe('LiveTvSourcesService.remove', () => {
  afterEach(() => jest.resetAllMocks());

  it('deletes only channels orphaned by the removed source, scoped to its own streams', async () => {
    const { service, source, sourceRepo, channelRepo, streamRepo } = setup({ id: 3 });
    const channelQb = makeQueryBuilder();
    channelRepo.createQueryBuilder.mockReturnValue(channelQb);
    const streamQb = makeQueryBuilder({
      getRawMany: jest.fn().mockResolvedValue([{ channelId: 5 }, { channelId: 6 }]),
    });
    streamRepo.createQueryBuilder.mockReturnValue(streamQb);

    await service.remove(3);

    expect(sourceRepo.remove).toHaveBeenCalledWith(source);
    // The candidate list comes only from this source's own streams, never every channel.
    expect(streamQb.where).toHaveBeenCalledWith('s."sourceId" = :sourceId', { sourceId: 3 });
    expect(channelQb.whereInIds).toHaveBeenCalledWith([5, 6]);
    expect(channelQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'));
    expect(channelQb.execute).toHaveBeenCalled();
  });

  it('never touches the channel table when the removed source had no streams', async () => {
    const { service, channelRepo, streamRepo } = setup({ id: 4 });
    streamRepo.createQueryBuilder.mockReturnValue(
      makeQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
    );

    await service.remove(4);

    expect(channelRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('LiveTvSourcesService.update', () => {
  afterEach(() => jest.resetAllMocks());

  it('keeps every field a partial PATCH left out (no Object.assign amputation)', async () => {
    const { service, sourceRepo } = setup({
      name: 'Provider',
      kind: 'm3u',
      url: 'http://provider/playlist.m3u',
      username: 'bob',
      password: 'secret',
      userAgent: 'Custom/1.0',
      referer: 'http://portal/',
      enabled: true,
    });

    // A real class instance ([[Define]] semantics), not a plain object literal:
    // matches what the global ValidationPipe actually hands the service.
    const dto = plainToInstance(UpdateLiveTvSourceDto, { enabled: false });
    const result = await service.update(1, dto);

    expect(sourceRepo.save).toHaveBeenCalled();
    expect(result).toMatchObject({
      url: 'http://provider/playlist.m3u',
      username: 'bob',
      password: 'secret',
      userAgent: 'Custom/1.0',
      referer: 'http://portal/',
      kind: 'm3u',
      enabled: false,
    });
    expect(result.url).not.toBeUndefined();
    expect(result.username).not.toBeUndefined();
  });
});
