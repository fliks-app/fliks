import { SystemController } from './system.controller';
import type { LiveSessionSnapshot } from '../streaming/live-session.service';

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
    return {
      sessionId: 'sid',
      userId: 1,
      username: 'alice',
      mediaFileId: 42,
      mediaTitle: 'title',
      mediaType: 'movie',
      posterUrl: null,
      profileHash: null,
      quality: null,
      kind: 'directplay',
      deviceLabel: null,
      systemName: null,
      sseConnectionId: null,
      startedAt: new Date(overrides.lastBeat),
      position: 0,
      state: 'playing',
      audioTrackIndex: null,
      subtitleTrackIndex: null,
      useTs: false,
      audioPlan: null,
      audioTrackPlans: null,
      audioStreamIndex: null,
      audioStreamCount: 0,
      useExtXMedia: false,
      deviceType: 'desktop',
      hdrLadder: false,
      supportsHlsSubtitles: false,
      probesSegZero: true,
      videoVariant: null,
      tonemapping: false,
      transcodeReasons: [],
      burnIn: null,
      encoderPreset: 'faster',
      canCopyVideo: false,
      canCopyAudio: false,
      pinned: false,
      ...overrides,
    };
  }

  function makeController(snapshots: LiveSessionSnapshot[]) {
    const transcodingService = {
      getDetectedHwAccel: jest.fn().mockReturnValue('none'),
      getActiveSessions: jest.fn().mockReturnValue([]),
    };
    const liveSessions = {
      list: jest.fn().mockReturnValue(snapshots),
    };
    const activeStreamTracker = {
      getDeviceName: jest.fn().mockReturnValue(null),
    };
    const playbackService = {
      getState: jest.fn().mockResolvedValue(null),
    };
    const mediaFileRepo = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    const controller = new SystemController(
      {} as never, // dataSource
      {} as never, // indexerRepo
      {} as never, // clientRepo
      {} as never, // libraryRepo
      {} as never, // qbittorrent
      {} as never, // backup
      {} as never, // logBuffer
      {} as never, // eventsService
      transcodingService as never,
      {} as never, // transcodeCache
      activeStreamTracker as never,
      liveSessions as never,
      playbackService as never,
      mediaFileRepo as never,
      {} as never, // episodeRepo
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
      get: jest.fn((id: string) =>
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
      listForJob: jest.fn().mockReturnValue([]),
    };
    const activeStreamTracker = { unregister: jest.fn() };
    const transcodingService = {
      getActiveSessions: jest.fn().mockReturnValue([]),
      killSessionsForJob: jest.fn(),
    };

    const controller = new SystemController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      eventsService as never,
      transcodingService as never,
      {} as never,
      activeStreamTracker as never,
      liveSessions as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return {
      controller,
      eventsService,
      liveSessions,
      activeStreamTracker,
      transcodingService,
    };
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
    const { controller, liveSessions, activeStreamTracker, transcodingService } =
      makeCommandController();

    controller.sendPlayerCommand('linux-sid', { action: 'stop' });

    expect(liveSessions.stop).toHaveBeenCalledWith('linux-sid');
    expect(activeStreamTracker.unregister).not.toHaveBeenCalled();
    expect(transcodingService.killSessionsForJob).not.toHaveBeenCalled();
  });
});
