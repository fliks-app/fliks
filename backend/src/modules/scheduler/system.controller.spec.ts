import * as fs from 'fs';
import { join } from 'path';
import { SystemController } from './system.controller';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
}));
import { buildLiveSession, type LiveSessionSnapshot } from '../streaming/live-session.service';

/**
 * Recency-filter coverage for the streams dashboard. `activeStreams()`
 * reads `LiveSessionRegistry.list()` (which returns every entry, stale or
 * not, by design) and must drop entries whose last beat is older than the
 * live-session TTL so a client that died doesn't linger on the dashboard
 * until the next GC sweep.
 */
describe('SystemController.activeStreams recency filter', () => {
  const ENV = process.env;

  beforeEach(() => {
    process.env = { ...ENV };
  });

  afterEach(() => {
    process.env = ENV;
  });

  function snapshot(
    overrides: Partial<LiveSessionSnapshot> & { lastBeat: Date },
  ): LiveSessionSnapshot {
    const base = buildLiveSession(
      { userId: 1, username: 'alice', mediaFileId: 42, kind: 'transcode' },
      'sid',
      0,
    );
    return {
      ...base,
      mediaTitle: 'title',
      mediaType: 'movie',
      startedAt: new Date(0),
      ...overrides,
    };
  }

  function makeController(snapshots: LiveSessionSnapshot[]) {
    const liveSessions = {
      list: jest.fn().mockReturnValue(snapshots),
    };
    const playbackService = {
      getState: jest.fn().mockResolvedValue(null),
    };
    const mediaFileRepo = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    const controller = new SystemController(
      {} as never, // dataSource
      {} as never, // libraryRepo
      {} as never, // healthProbes
      {} as never, // backup
      {} as never, // logBuffer
      {} as never, // eventsService
      { hwAccel: 'none' } as never, // hardware
      liveSessions as never,
      { listForActivity: () => [] } as never, // liveTvSessions
      playbackService as never,
      mediaFileRepo as never,
      {} as never, // episodeRepo
      {} as never, // requestRepo
      {} as never, // updateCheck
      { liveSummary: () => null } as never, // qoe
    );

    return { controller };
  }

  it('hides a session whose lastBeat is older than the TTL', async () => {
    process.env.STREAM_LIVE_SESSION_TTL_MS = '30000';
    const fresh = snapshot({
      sessionId: 'fresh',
      lastBeat: new Date(Date.now() - 1_000),
    });
    const stale = snapshot({
      sessionId: 'stale',
      lastBeat: new Date(Date.now() - 60_000),
    });
    const { controller } = makeController([fresh, stale]);

    const streams = await controller.activeStreams();

    const ids = streams.map((s) => s.sessionId);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('honours STREAM_LIVE_SESSION_TTL_MS when sizing the cutoff', async () => {
    // With a tiny TTL even a 1 s-old beat is stale.
    process.env.STREAM_LIVE_SESSION_TTL_MS = '500';
    const stale = snapshot({
      sessionId: 'stale',
      lastBeat: new Date(Date.now() - 1_000),
    });
    const { controller } = makeController([stale]);

    const streams = await controller.activeStreams();

    expect(streams).toHaveLength(0);
  });
});

describe('SystemController.sendPlayerCommand', () => {
  function makeCommandController(liveOverrides: Record<string, unknown> = {}) {
    const eventsService = {
      emitToUser: jest.fn(),
      emitToConnection: jest.fn(),
      hasConnection: jest.fn().mockReturnValue(false),
    };
    const liveSession = {
      sessionId: 'linux-sid',
      userId: 1,
      mediaFileId: 42,
      profileHash: 'profile-linux',
      kind: 'directplay' as const,
      sseConnectionId: null,
      ...liveOverrides,
    };
    const liveSessions = {
      peek: jest.fn((id: string) =>
        id === 'linux-sid' ? liveSession : null,
      ),
      stop: jest.fn().mockReturnValue(true),
      list: jest.fn().mockReturnValue([
        {
          sessionId: 'android-sid',
          userId: 1,
          mediaFileId: 42,
        },
      ]),
    };

    const controller = new SystemController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      eventsService as never,
      {} as never, // hardware
      liveSessions as never,
      { listForActivity: () => [] } as never, // liveTvSessions
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return { controller, eventsService, liveSessions };
  }

  it('includes sessionId in the player.command SSE payload', () => {
    const { controller, eventsService } = makeCommandController();

    controller.sendPlayerCommand('linux-sid', { action: 'pause' });

    expect(eventsService.emitToUser).toHaveBeenCalledWith(1, {
      type: 'player.command',
      sessionId: 'linux-sid',
      mediaFileId: 42,
      userId: 1,
      action: 'pause',
      message: undefined,
    });
    expect(eventsService.emitToConnection).not.toHaveBeenCalled();
  });

  it('routes player.command to the bound SSE connection when present', () => {
    const { controller, eventsService } = makeCommandController({
      sseConnectionId: 'conn-1',
    });
    eventsService.hasConnection.mockReturnValue(true);

    controller.sendPlayerCommand('linux-sid', { action: 'pause' });

    expect(eventsService.emitToConnection).toHaveBeenCalledWith('conn-1', {
      type: 'player.command',
      sessionId: 'linux-sid',
      mediaFileId: 42,
      userId: 1,
      action: 'pause',
      message: undefined,
    });
    expect(eventsService.emitToUser).not.toHaveBeenCalled();
  });

  it('stops only the targeted live session and keeps sibling viewers', () => {
    const { controller, liveSessions } = makeCommandController();

    controller.sendPlayerCommand('linux-sid', { action: 'stop' });

    expect(liveSessions.stop).toHaveBeenCalledTimes(1);
    expect(liveSessions.stop).toHaveBeenCalledWith('linux-sid');
  });
});

describe('SystemController with the engine', () => {
  const recorded = JSON.parse(
    fs.readFileSync(join(__dirname, '../streaming/services/engine-playback.recorded.json'), 'utf8'),
  ).engine.decision;
  const decision = {
    ...recorded,
    response: {
      ...recorded.response,
      transcodeReasons: [
        { flag: 'VideoCodecNotSupported', message: 'video reason' },
        { flag: 'AudioChannelsNotSupported', message: 'audio reason' },
        { flag: 'ContainerNotSupported', message: 'container reason' },
      ],
    },
  };
  const snap = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sid-live',
    ownerId: '1',
    mediaFileId: 42,
    quality: '480p',
    lastBeatMs: 1_700_000_000_000,
    decision,
    job: { state: 'running', quality: '480p', requestedHw: 'vaapi', actualHw: 'none', startSegment: 0, transcodePercent: 42.5, throttled: false, restarts: 1, stderrTail: [] },
    ...over,
  });
  const presence = (id: string, lastBeat: Date) => ({
    ...buildLiveSession({ userId: 1, username: 'alice', mediaFileId: 42, kind: 'transcode', quality: '720p' }, id, 0),
    sessionId: id,
    mediaTitle: 'Dune',
    mediaType: 'movie',
    startedAt: new Date(0),
    lastBeat,
  });

  function make(engine: Record<string, unknown> | undefined, sessions: unknown[] = []) {
    const liveSessions = {
      list: jest.fn().mockReturnValue(sessions),
      peek: jest.fn((id: string) => (sessions as { sessionId: string }[]).find((s) => s.sessionId === id) ?? null),
      stop: jest.fn(),
    };
    const controller = new SystemController(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { emitToUser: jest.fn(), hasConnection: () => false } as never,
      { hwAccel: 'vaapi' } as never,
      liveSessions as never,
      { listForActivity: () => [] } as never,
      {} as never,
      { findByIds: jest.fn().mockResolvedValue([]) } as never,
      {} as never, {} as never, {} as never,
      { liveSummary: () => null } as never,
      engine as never,
    );
    return { controller, liveSessions };
  }
  const running = (over: Record<string, unknown> = {}): Record<string, any> => ({
    runtime: true,
    status: 'up',
    listSessions: jest.fn().mockResolvedValue([snap()]),
    ...over,
  });

  describe('GET streams', () => {
    it('lists what the engine holds, with its job, its real hardware and its reasons', async () => {
      const stale = presence('sid-live', new Date(Date.now() - 3_600_000));
      const { controller } = make(running(), [stale, presence('sid-ghost', new Date())]);
      const streams = await controller.activeStreams();
      expect(streams).toHaveLength(1);
      expect(streams[0]).toMatchObject({
        sessionId: 'sid-live',
        quality: '480p',
        hwAccel: 'none',
        transcodePercent: 42.5,
        engineStatus: 'up',
        lastActivity: new Date(1_700_000_000_000).toISOString(),
        videoReasons: ['video reason'],
        audioReasons: ['audio reason'],
        containerReasons: ['container reason'],
        job: { state: 'running', requestedHw: 'vaapi', actualHw: 'none' },
      });
    });

    it('falls back to the registry when the engine cannot be listed', async () => {
      const engine = running({ listSessions: jest.fn().mockRejectedValue(new Error('down')), status: 'down' });
      const { controller } = make(engine, [presence('a', new Date()), presence('b', new Date(Date.now() - 3_600_000))]);
      const streams = await controller.activeStreams();
      expect(streams.map((s) => s.sessionId)).toEqual(['a']);
      expect(streams[0]).toMatchObject({ engineStatus: 'down', job: null, hwAccel: 'vaapi' });
    });

    it('reports the engine as off, with no job, without one', async () => {
      const { controller } = make(undefined, [presence('a', new Date())]);
      expect(await controller.activeStreams()).toMatchObject([{ engineStatus: 'off', job: null }]);
    });
  });

  describe('transcode cache', () => {
    const cache = {
      usedBytes: 700,
      entries: [
        { mediaFileId: 1, ownerId: '7', bytes: 100, live: false },
        { mediaFileId: 1, ownerId: '8', bytes: 200, live: false },
        { mediaFileId: 2, ownerId: '7', bytes: 400, live: true },
      ],
    };
    const eng = () => running({ cache: jest.fn().mockResolvedValue(cache), purgeCache: jest.fn().mockResolvedValue(2) });

    it('reads the engine cache for the footprint', async () => {
      const { controller } = make(eng());
      expect(await controller.transcodeCacheStats()).toEqual({ entries: 3, bytes: 700 });
    });

    it('purges all of it, counting what the engine can remove (live entries stay)', async () => {
      const e = eng();
      const { controller } = make(e);
      expect(await controller.purgeAllTranscodeCache()).toEqual({ ok: true, entries: 2, bytes: 300 });
      expect(e.purgeCache).toHaveBeenCalledWith({ mediaFileId: undefined, ownerId: undefined });
    });

    it('purges one file, optionally for one user', async () => {
      const e = eng();
      const { controller } = make(e);
      expect(await controller.purgeTranscodeCache(1, '7')).toEqual({ ok: true, entries: 1, bytes: 100 });
      expect(e.purgeCache).toHaveBeenCalledWith({ mediaFileId: 1, ownerId: '7' });
    });

    it('is empty without the engine runtime', async () => {
      const { controller } = make(undefined);
      expect(await controller.transcodeCacheStats()).toEqual({ entries: 0, bytes: 0 });
      expect(await controller.purgeAllTranscodeCache()).toEqual({ ok: true, entries: 0, bytes: 0 });
    });
  });

  describe('POST streams/:sid/command stop', () => {
    it('ends the presence and the engine session', () => {
      const engine = running({ deleteSession: jest.fn().mockResolvedValue(undefined) });
      const { controller, liveSessions } = make(engine, [presence('sid-live', new Date())]);
      controller.sendPlayerCommand('sid-live', { action: 'stop' });
      expect(liveSessions.stop).toHaveBeenCalledWith('sid-live');
      expect(engine.deleteSession).toHaveBeenCalledWith('sid-live');
    });

    it('does not stop anything for a pause', () => {
      const engine = running({ deleteSession: jest.fn() });
      const { controller, liveSessions } = make(engine, [presence('sid-live', new Date())]);
      controller.sendPlayerCommand('sid-live', { action: 'pause' });
      expect(liveSessions.stop).not.toHaveBeenCalled();
      expect(engine.deleteSession).not.toHaveBeenCalled();
    });
  });
});

describe('SystemController.restart', () => {
  const ENV = process.env;

  function makeController() {
    return new SystemController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.pm_id;
    delete process.env.INVOCATION_ID;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = ENV;
    process.exitCode = undefined;
  });

  it('refuses to exit when no supervisor would bring the server back', () => {
    delete process.env.FLIKS_SUPERVISED;
    jest.mocked(fs.existsSync).mockReturnValue(false);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(() => makeController().restart()).toThrow();
    jest.runAllTimers();
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('signals a graceful shutdown with a non-zero exit code when supervised', () => {
    process.env.FLIKS_SUPERVISED = '1';
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(makeController().restart()).toEqual({
      ok: true,
      supervisor: 'supervisor',
    });
    expect(process.exitCode).toBe(1);
    expect(kill).not.toHaveBeenCalled(); // only after the response flushes
    jest.runAllTimers();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('signals PID 1 in a container so the container itself exits', () => {
    delete process.env.FLIKS_SUPERVISED;
    jest.mocked(fs.existsSync).mockReturnValue(true);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(makeController().restart()).toEqual({
      ok: true,
      supervisor: 'docker',
    });
    jest.runAllTimers();
    expect(kill).toHaveBeenCalledWith(1, 'SIGTERM');
  });
});
