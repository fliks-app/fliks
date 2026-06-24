import {
  StreamingController,
  withTimestampMap,
  buildVodPlaylist,
  buildVariableVodPlaylist,
} from './streaming.controller';
import type { LiveSession } from './live-session.service';

describe('buildVodPlaylist', () => {
  const url = (i: string): string => `seg-${i}.m4s`;
  const lines = (m: string, prefix: string): string[] =>
    m.split('\n').filter((l) => l.startsWith(prefix));

  it('drops the phantom last segment from float-imprecise durations', () => {
    // 120.001 / 3 naively ceils to 41, but ffmpeg writes 40 — the epsilon trims it.
    expect(lines(buildVodPlaylist(120.001, url, undefined, 3), '#EXTINF')).toHaveLength(40);
  });

  it('clamps the final EXTINF to the remainder and sets TARGETDURATION', () => {
    const m = buildVodPlaylist(10, url, undefined, 3);
    const extinf = lines(m, '#EXTINF');
    expect(extinf).toEqual([
      '#EXTINF:3.000,',
      '#EXTINF:3.000,',
      '#EXTINF:3.000,',
      '#EXTINF:1.000,',
    ]);
    expect(m).toContain('#EXT-X-TARGETDURATION:3');
    expect(m).not.toContain('#EXT-X-MAP'); // no initUrl
  });

  it('rounds TARGETDURATION up for fractional segment durations + emits the map', () => {
    const m = buildVodPlaylist(9.009, url, 'init.mp4', 3.003);
    expect(m).toContain('#EXT-X-TARGETDURATION:4');
    expect(m).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(lines(m, '#EXTINF')[0]).toBe('#EXTINF:3.003,');
  });
});

describe('buildVariableVodPlaylist', () => {
  const url = (i: string): string => `seg-${i}.m4s`;
  it('emits one EXTINF per real duration and TARGETDURATION = ceil(max)', () => {
    const m = buildVariableVodPlaylist([3.003, 2.961, 4.2], url);
    expect(m.split('\n').filter((l) => l.startsWith('#EXTINF'))).toEqual([
      '#EXTINF:3.003,',
      '#EXTINF:2.961,',
      '#EXTINF:4.200,',
    ]);
    expect(m).toContain('#EXT-X-TARGETDURATION:5');
  });
});

describe('withTimestampMap', () => {
  const mapLine = (vtt: string): string | undefined =>
    vtt.split('\n').find((l) => l.startsWith('X-TIMESTAMP-MAP'));

  it('emits MPEGTS:0 (no-op) for a zero start time', () => {
    expect(mapLine(withTimestampMap('WEBVTT\n\n'))).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
    );
  });

  it('offsets cues by the source start PTS on the 90kHz clock', () => {
    // 1.4s × 90000 → the cue at LOCAL 0 maps to the first frame, not 1.4s early.
    expect(mapLine(withTimestampMap('WEBVTT\n\n', 1.4))).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000',
    );
  });
});

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
      systemName: null,
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
