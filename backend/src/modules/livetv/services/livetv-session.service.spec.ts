import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { EngineError, type EngineEvent } from '../../engine/engine.service';
import type { User } from '../../users/entities/user.entity';
import type { LiveTvChannel } from '../entities/livetv-channel.entity';
import type { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { LiveTvCapacityService } from './livetv-capacity.service';
import { LiveTvSessionService } from './livetv-session.service';

const user = { id: 7, username: 'ann' } as User;

function source(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Src',
    maxStreams: 0,
    userAgent: null,
    referer: null,
    ...over,
  };
}

function stream(
  id: number,
  over: Record<string, unknown> = {},
): LiveTvChannelStream {
  const src = (over.source as ReturnType<typeof source>) ?? source();
  return {
    id,
    channelId: 1,
    sourceId: src.id,
    priority: 0,
    url: `http://provider.example/${id}.ts`,
    source: src,
    ...over,
  } as unknown as LiveTvChannelStream;
}

const channel = (streams: LiveTvChannelStream[]) =>
  ({ id: 1, name: 'Channel 1', streams }) as unknown as LiveTvChannel;

describe('LiveTvSessionService', () => {
  let service: LiveTvSessionService;
  let engine: {
    openLive: jest.Mock;
    deleteSession: jest.Mock;
    listLive: jest.Mock;
    pushLivetv: jest.Mock;
    whenReady: jest.Mock;
  };
  let streamRepo: { update: jest.Mock; find: jest.Mock };
  let bump: { execute: jest.Mock; where: jest.Mock };
  let settings: { get: jest.Mock; addChangeListener: jest.Mock };
  let activity: { upsertRunning: jest.Mock; remove: jest.Mock };
  let qoe: {
    register: jest.Mock;
    setPipeline: jest.Mock;
    sessionEnded: jest.Mock;
    observeServed: jest.Mock;
    addTranscodeProbe: jest.Mock;
  };
  let capacity: LiveTvCapacityService;
  let events: {
    handle?: (ev: EngineEvent) => void;
    resync?: () => Promise<void>;
  };

  const answer = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sid-1',
    playPath: '/api/livetv/sessions/sid-1/index.m3u8',
    mode: 'remux',
    upstream: 0,
    capacityToken: '',
    dvrWindowSeconds: 900,
    segmentSeconds: 2,
    qoePipeline: {},
    ...over,
  });
  /** An engine answering the open with the request's own token, as a fresh session does. */
  const startsSession = (over: Record<string, unknown> = {}) =>
    engine.openLive.mockImplementation(async (req: { capacityToken: string }) =>
      answer({ capacityToken: req.capacityToken, ...over }),
    );
  const tokenOf = () =>
    (engine.openLive.mock.calls[0][0] as { capacityToken: string })
      .capacityToken;
  const emit = async (ev: unknown) => {
    events.handle!(ev as EngineEvent);
    await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    engine = {
      openLive: jest.fn(),
      deleteSession: jest.fn(),
      listLive: jest.fn().mockResolvedValue([]),
      pushLivetv: jest.fn(),
      whenReady: jest.fn().mockResolvedValue(undefined),
    };
    streamRepo = { update: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    bump = { execute: jest.fn(), where: jest.fn() };
    bump.where.mockReturnValue(bump);
    const channelRepo = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: bump.where,
        execute: bump.execute,
      })),
    };
    settings = {
      get: jest.fn().mockResolvedValue(null),
      addChangeListener: jest.fn(),
    };
    activity = { upsertRunning: jest.fn(), remove: jest.fn() };
    qoe = {
      register: jest.fn(),
      setPipeline: jest.fn(),
      sessionEnded: jest.fn(),
      observeServed: jest.fn(),
      addTranscodeProbe: jest.fn(),
    };
    capacity = new LiveTvCapacityService();
    events = {};
    const bus = {
      onEvent: (l: (ev: EngineEvent) => void) => (events.handle = l),
      onResync: (l: () => Promise<void>) => (events.resync = l),
    };
    service = new LiveTvSessionService(
      channelRepo as never,
      streamRepo as never,
      settings as never,
      activity as never,
      capacity,
      engine as never,
      bus as never,
      qoe as never,
    );
    service.onModuleInit();
  });

  it('opens through the engine with the sorted upstreams, its headers and the viewer as owner', async () => {
    startsSession();
    const bad = stream(1, { lastError: 'x' });
    const good = stream(2, {
      source: source({ id: 2, userAgent: 'UA', referer: 'http://r/' }),
      probedVideoCodec: 'h264',
    });

    const res = await service.open(channel([bad, good]), user, {
      maxBitrateBps: 3_000_000,
      userAgent: 'Dev',
    });

    expect(res).toMatchObject({
      sessionId: 'sid-1',
      url: '/api/livetv/sessions/sid-1/index.m3u8',
      mode: 'remux',
      isLive: true,
      dvrWindowSeconds: 900,
    });
    const req = engine.openLive.mock.calls[0][0];
    expect(req).toMatchObject({
      channelId: '1',
      ownerId: '7',
      atCapacity: false,
      caps: { maxBitrateBps: 3_000_000 },
      tags: { channelName: 'Channel 1', username: 'ann', device: 'Dev' },
    });
    expect(req.upstreams.map((u: { url: string }) => u.url)).toEqual([
      good.url,
      bad.url,
    ]);
    expect(req.upstreams[0]).toMatchObject({
      headers: { 'User-Agent': 'UA', Referer: 'http://r/' },
      probedVideoCodec: 'h264',
    });
    expect(service.viewer('sid-1')).toMatchObject({ channelId: 1 });
    expect(qoe.register).toHaveBeenCalled();
    expect(activity.upsertRunning).toHaveBeenCalledWith(
      expect.stringContaining('livetv:'),
      'livetv.viewing',
      { title: 'Channel 1' },
      1,
    );
  });

  it('frees its hold at once when the open joined a running session', async () => {
    engine.openLive.mockResolvedValue(
      answer({ capacityToken: 'someone-else' }),
    );
    const limited = source({ maxStreams: 1 });
    await service.open(channel([stream(1, { source: limited })]), user, {});

    // The slot is free again: a second open is not told the source is full.
    engine.openLive.mockClear();
    startsSession();
    await service.open(channel([stream(1, { source: limited })]), user, {});
    expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(false);
  });

  it('sends the capacity verdict and maps the engine 409 onto it', async () => {
    startsSession();
    const limited = source({ maxStreams: 1 });
    await service.open(channel([stream(1, { source: limited })]), user, {});

    engine.openLive.mockReset();
    engine.openLive.mockRejectedValue(
      new EngineError(409, 'POST /v1/live', 'live_at_capacity'),
    );
    await expect(
      service.open(channel([stream(1, { source: limited })]), user, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(true);

    // The refused open held nothing: only the first session's hold remains.
    engine.openLive.mockReset();
    engine.openLive.mockRejectedValue(
      new EngineError(409, 'POST /v1/live', 'live_at_capacity'),
    );
    await expect(
      service.open(channel([stream(1, { source: limited })]), user, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(true);
  });

  it('answers a dead channel as unavailable, counting the failure and starting the release grace', async () => {
    engine.openLive.mockRejectedValue(
      new EngineError(503, 'POST /v1/live', 'live_unavailable'),
    );
    const release = jest.spyOn(capacity, 'recordRelease');

    await expect(
      service.open(channel([stream(1)]), user, {}),
    ).rejects.toMatchObject({
      response: { code: 'livetv_channel_unavailable' },
    });
    expect(bump.where).toHaveBeenCalledWith('id = :id', { id: 1 });
    expect(release).toHaveBeenCalledWith(1);

    // The engine's own LiveReleased for the same token arrives later: nothing counted twice.
    await emit({
      type: 'LiveReleased',
      capacityToken: tokenOf(),
      reason: 'failed',
    });
    expect(bump.execute).toHaveBeenCalledTimes(1);
  });

  it('names an expired account', async () => {
    engine.openLive.mockRejectedValue(
      new EngineError(503, 'POST /v1/live', 'live_unavailable'),
    );
    const expired = source({
      name: 'Old',
      expiresAt: new Date(Date.now() - 1000),
      accountStatus: null,
    });
    const err = await service
      .open(channel([stream(1, { source: expired })]), user, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'livetv_account_expired',
      sourceName: 'Old',
    });
  });

  it('gives the hold back on any other refusal', async () => {
    engine.openLive.mockRejectedValue(new EngineError(400, 'POST /v1/live'));
    const limited = source({ maxStreams: 1 });
    await expect(
      service.open(channel([stream(1, { source: limited })]), user, {}),
    ).rejects.toBeInstanceOf(EngineError);

    startsSession();
    await service.open(channel([stream(1, { source: limited })]), user, {});
    expect(engine.openLive.mock.calls[1][0].atCapacity).toBe(false);
  });

  describe('engine events', () => {
    beforeEach(async () => {
      startsSession();
    });

    it('moves the hold to the source of the upstream that now feeds the session', async () => {
      const a = stream(1, { source: source({ id: 1, maxStreams: 1 }) });
      const b = stream(2, { source: source({ id: 2, maxStreams: 1 }) });
      await service.open(channel([a, b]), user, {});

      await emit({
        type: 'LiveAttempt',
        capacityToken: tokenOf(),
        upstream: 1,
        probe: { videoCodec: 'h264', container: 'mpegts' },
      });

      expect(streamRepo.update).toHaveBeenCalledWith(2, {
        probedVideoCodec: 'h264',
        probedContainer: 'mpegts',
        lastOkAt: expect.any(Date),
        lastError: null,
      });
      // Source 1 is free again, source 2 holds the connection.
      engine.openLive.mockClear();
      await service.open(channel([a]), { id: 8 } as User, {});
      expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(false);
      engine.openLive.mockClear();
      await service.open(channel([b]), { id: 8 } as User, {});
      expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(true);
    });

    it('records a failed upstream and starts the release grace only when it had been feeding', async () => {
      const a = stream(1);
      const b = stream(2);
      await service.open(channel([a, b]), user, {});
      const release = jest.spyOn(capacity, 'recordRelease');
      const token = tokenOf();

      await emit({
        type: 'LiveAttempt',
        capacityToken: token,
        upstream: 0,
        error: 'no segment',
      });
      expect(streamRepo.update).toHaveBeenLastCalledWith(1, {
        lastError: 'no segment',
      });
      expect(release).not.toHaveBeenCalled();

      await emit({ type: 'LiveAttempt', capacityToken: token, upstream: 1 });
      await emit({
        type: 'LiveAttempt',
        capacityToken: token,
        upstream: 1,
        error: 'upstream closed',
      });
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('frees the token on LiveReleased and counts a failed session against the channel', async () => {
      await service.open(channel([stream(1)]), user, {});
      const release = jest.spyOn(capacity, 'recordRelease');

      await emit({
        type: 'LiveReleased',
        capacityToken: tokenOf(),
        reason: 'idle',
      });
      expect(release).toHaveBeenCalledWith(1);
      expect(bump.execute).not.toHaveBeenCalled();
      expect(activity.remove).toHaveBeenCalledWith(`livetv:${tokenOf()}`);
    });

    it('bumps the failure count on LiveReleased failed', async () => {
      await service.open(channel([stream(1)]), user, {});
      await emit({
        type: 'LiveReleased',
        capacityToken: tokenOf(),
        reason: 'failed',
      });
      expect(bump.execute).toHaveBeenCalledTimes(1);
    });

    it('drops the viewer and its QoE session on SessionEnded', async () => {
      await service.open(channel([stream(1)]), user, {});
      await emit({
        type: 'SessionEnded',
        sessionId: 'sid-1',
        reason: 'expired',
      });
      expect(service.viewer('sid-1')).toBeUndefined();
      expect(qoe.sessionEnded).toHaveBeenCalled();
    });

    it("feeds a live segment's CMCD to the viewer's QoE session", async () => {
      await service.open(channel([stream(1)]), user, {});
      await emit({ type: 'SegmentServed', sessionId: 'sid-1', waitedMs: 0 });
      expect(qoe.observeServed).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sid-1', kind: 'live' }),
        null,
        2,
        0,
      );
    });
  });

  it('leaves through the engine', async () => {
    startsSession();
    await service.open(channel([stream(1)]), user, {});
    await service.leave('sid-1');
    expect(engine.deleteSession).toHaveBeenCalledWith('sid-1');
    expect(service.viewer('sid-1')).toBeUndefined();
  });

  it('rebuilds viewers from the engine on resync and drops the ones it lost', async () => {
    startsSession();
    await service.open(channel([stream(1)]), user, {});
    engine.listLive.mockResolvedValue([
      {
        sessionId: 'sid-9',
        channelId: '4',
        ownerId: '3',
        capacityToken: 'other',
        tags: { channelName: 'Four' },
        openedAtMs: 1,
      },
    ]);

    await new Promise((r) => setTimeout(r, 5));
    await events.resync!();

    expect(service.viewer('sid-9')).toMatchObject({ channelId: 4 });
    expect(service.viewer('sid-1')).toBeUndefined();
    // Its token is gone too: the capacity it held is released, with no grace.
    settings.get.mockImplementation(async (k: string) =>
      k === 'livetv_slot_release_seconds' ? '0' : null,
    );
    engine.openLive.mockClear();
    await service.open(
      channel([stream(1, { source: source({ maxStreams: 1 }) })]),
      user,
      {},
    );
    expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(false);
  });

  it('rebuilds the capacity holds from the snapshots on resync', async () => {
    const fed = stream(5, {
      channelId: 4,
      priority: 2,
      url: 'http://p/five.ts',
      source: source({ id: 9, maxStreams: 1 }),
    });
    streamRepo.find = jest
      .fn()
      .mockResolvedValue([stream(4, { channelId: 4, priority: 0 }), fed]);
    engine.listLive.mockResolvedValue([
      {
        sessionId: 'sid-9',
        channelId: '4',
        capacityToken: 'lost',
        mode: 'transcode',
        tags: {},
        upstream: 1,
        upstreamUrl: 'http://p/five.ts',
        upstreamPriority: 2,
        openedAtMs: 1,
      },
    ]);

    await events.resync!();

    startsSession();
    await service.open(
      channel([stream(1, { source: source({ id: 9, maxStreams: 1 }) })]),
      user,
      {},
    );
    expect(engine.openLive.mock.calls[0][0].atCapacity).toBe(true);
    // An attempt of the restored session reaches its stream's health.
    await emit({
      type: 'LiveAttempt',
      capacityToken: 'lost',
      upstream: 3,
      upstreamUrl: 'http://p/five.ts',
      upstreamPriority: 2,
    });
    expect(streamRepo.update).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ lastError: null }),
    );
  });

  it('counts the live transcodes for the QoE load probe', async () => {
    const probe = (qoe as unknown as { addTranscodeProbe: jest.Mock })
      .addTranscodeProbe.mock.calls[0][0] as () => number;
    startsSession({ mode: 'transcode' });
    await service.open(channel([stream(1)]), user, {});
    expect(probe()).toBe(1);
    await emit({
      type: 'LiveReleased',
      capacityToken: tokenOf(),
      reason: 'idle',
    });
    expect(probe()).toBe(0);

    streamRepo.find = jest
      .fn()
      .mockResolvedValue([stream(1, { channelId: 4, url: 'u', priority: 0 })]);
    engine.listLive.mockResolvedValue([
      {
        sessionId: 's',
        channelId: '4',
        capacityToken: 'lost',
        mode: 'transcode',
        tags: {},
        upstream: 0,
        upstreamUrl: 'u',
        upstreamPriority: 0,
        openedAtMs: 1,
      },
    ]);
    await events.resync!();
    expect(probe()).toBe(1);
  });

  it('lists the activity rows from the engine snapshots', async () => {
    engine.listLive.mockResolvedValue([
      {
        sessionId: 's',
        channelId: '1',
        ownerId: '7',
        capacityToken: 't',
        mode: 'transcode',
        tags: { channelName: 'C', username: 'ann', device: '' },
        openedAtMs: 5,
        lastSeenMs: 6,
        videoCodec: 'h264',
        container: 'fmp4',
        upstream: 0,
        viewersOnUpstream: 2,
      },
    ]);
    expect(await service.listForActivity()).toEqual([
      expect.objectContaining({
        sessionId: 's',
        channelId: 1,
        userId: 7,
        username: 'ann',
        device: null,
        videoCodec: 'h264',
        audioCodec: null,
        viewersOnUpstream: 2,
      }),
    ]);
  });

  it('pushes the live TV settings to the engine, with the segment floor', async () => {
    const values: Record<string, string> = {
      livetv_segment_seconds: '0',
      livetv_fast_zap: 'false',
      livetv_channel_idle_seconds: '45',
    };
    settings.get.mockImplementation(async (k: string) => values[k] ?? null);
    (settings.addChangeListener.mock.calls[0][0] as (key: string) => void)(
      'livetv_segment_seconds',
    );
    await new Promise((r) => setImmediate(r));
    expect(engine.pushLivetv).toHaveBeenLastCalledWith({
      segmentSeconds: 1,
      timeshiftMinutes: 15,
      probeSeconds: 3,
      channelIdleSeconds: 45,
      fastZap: false,
    });
  });
});
