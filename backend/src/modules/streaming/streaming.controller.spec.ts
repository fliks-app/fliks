import { StreamingController } from './streaming.controller';
import type { LiveSession } from './live-session.service';

/**
 * Focused unit tests for the sid-scoped stop handler. The controller is
 * instantiated directly with stub collaborators — `stopLiveSession` only
 * touches the live-session registry, the DirectPlay tracker, and the
 * transcoding service, so the rest of the (large) constructor surface is
 * irrelevant here.
 */
describe('StreamingController.stopLiveSession', () => {
  function makeController(live: LiveSession | null) {
    const liveSessions = {
      get: jest.fn().mockReturnValue(live),
      stop: jest.fn(),
      list: jest.fn().mockReturnValue([]),
      listForJob: jest.fn().mockReturnValue([]),
    };
    const activeStreamTracker = {
      unregister: jest.fn(),
    };
    const transcodingService = {
      killSessionsForJob: jest.fn(),
    };

    const controller = new StreamingController(
      {} as never, // streamingService
      {} as never, // subtitleStreamService
      transcodingService as never,
      {} as never, // streamBuilder
      activeStreamTracker as never,
      {} as never, // subtitleBurnIn
      {} as never, // thumbnailService
      {} as never, // playbackService
      {} as never, // markersService
      {} as never, // streamingSettingsCache
      liveSessions as never,
      {} as never, // segmentPackaging
      {} as never, // sessionRouter
      {} as never, // sessionContextBuilder
    );

    return { controller, liveSessions, activeStreamTracker, transcodingService };
  }

  function makeLive(overrides: Partial<LiveSession>): LiveSession {
    return {
      sessionId: 'sid-1',
      userId: 7,
      username: 'alice',
      mediaFileId: 42,
      mediaTitle: null,
      mediaType: null,
      posterUrl: null,
      profileHash: null,
      quality: null,
      kind: 'directplay',
      deviceLabel: null,
      sseConnectionId: null,
      startedAt: Date.now(),
      lastBeat: Date.now(),
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

  it('unregisters the now-watching row for a DirectPlay sid (null profileHash)', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, activeStreamTracker, transcodingService } =
      makeController(live);

    controller.stopLiveSession('sid-1');

    expect(liveSessions.stop).toHaveBeenCalledWith('sid-1');
    // DirectPlay has no profileHash, so the ffmpeg-kill path is skipped —
    // the tracker row must still be cleared immediately.
    expect(activeStreamTracker.unregister).toHaveBeenCalledWith(7, 42);
    expect(transcodingService.killSessionsForJob).not.toHaveBeenCalled();
  });

  it('also unregisters for a transcode sid, then walks the ffmpeg-kill path', () => {
    const live = makeLive({ profileHash: 'abc123', userId: 7, mediaFileId: 42 });
    const { controller, activeStreamTracker, liveSessions, transcodingService } =
      makeController(live);

    controller.stopLiveSession('sid-1');

    expect(activeStreamTracker.unregister).toHaveBeenCalledWith(7, 42);
    expect(liveSessions.listForJob).toHaveBeenCalledWith(7, 42, 'abc123');
    // No other live session references the job → reap every ffmpeg variant.
    expect(transcodingService.killSessionsForJob).toHaveBeenCalledWith(
      42,
      7,
      'abc123',
    );
  });

  it('is a no-op on an unknown sid', () => {
    const { controller, activeStreamTracker, liveSessions } =
      makeController(null);

    controller.stopLiveSession('missing');

    expect(liveSessions.stop).toHaveBeenCalledWith('missing');
    expect(activeStreamTracker.unregister).not.toHaveBeenCalled();
  });

  it('skips unregister when another live session remains on the same file', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, activeStreamTracker } = makeController(live);
    liveSessions.list.mockReturnValue([
      { sessionId: 'sid-2', userId: 7, mediaFileId: 42 },
    ]);

    controller.stopLiveSession('sid-1');

    expect(activeStreamTracker.unregister).not.toHaveBeenCalled();
  });

  it('does not unregister when the session has no userId', () => {
    const live = makeLive({ profileHash: null, userId: null, mediaFileId: 42 });
    const { controller, activeStreamTracker } = makeController(live);

    controller.stopLiveSession('sid-1');

    expect(activeStreamTracker.unregister).not.toHaveBeenCalled();
  });
});
