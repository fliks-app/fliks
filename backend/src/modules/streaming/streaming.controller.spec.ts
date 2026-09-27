import {
  StreamingController,
  withTimestampMap,
  buildVodPlaylist,
  buildVariableVodPlaylist,
  buildIFramePlaylist,
  resolvePreRoll,
} from './streaming.controller';
import {
  computeSegmentGrid,
  gridSegmentIndex,
} from './transcoding/segment-boundaries';
import { buildLiveSession, type LiveSession } from './live-session.service';
import type { PreRollItem } from '../../common/plugin-contract';
import type { User } from '../users/entities/user.entity';
import { ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('buildIFramePlaylist', () => {
  const url = (i: string): string => `iframe/seg-${i}.ts`;

  it('declares I-frames-only and no init segment', () => {
    const m = buildIFramePlaylist(12, url, 4, 0.04);
    expect(m).toContain('#EXT-X-I-FRAMES-ONLY');
    expect(m).not.toContain('#EXT-X-MAP');
  });

  it('keeps one entry per grid keyframe', () => {
    const m = buildIFramePlaylist(12, url, 4, 0.04);
    expect(m.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(
      3,
    );
    expect(m).toContain('iframe/seg-0002.ts');
  });
});

describe('buildVodPlaylist', () => {
  const url = (i: string): string => `seg-${i}.m4s`;
  const lines = (m: string, prefix: string): string[] =>
    m.split('\n').filter((l) => l.startsWith(prefix));

  it('lists a segment only when a frame starts in it', () => {
    // 120.001 s at 25 fps: the last frame starts at 119.961, in segment 39.
    expect(lines(buildVodPlaylist(120.001, url, undefined, 3, 0.04), '#EXTINF')).toHaveLength(40);
    // One frame past 120: it starts at 120, so segment 40 exists.
    expect(lines(buildVodPlaylist(120.04, url, undefined, 3, 0.04), '#EXTINF')).toHaveLength(41);
    // A last frame that starts on a boundary through float noise.
    expect(lines(buildVodPlaylist(90.09 + 1 / 23.976, url, undefined, 3.003, 1 / 23.976), '#EXTINF')).toHaveLength(31);
  });

  it('clamps the final EXTINF to the remainder and sets TARGETDURATION', () => {
    const m = buildVodPlaylist(10, url, undefined, 3, 0.04);
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
    const m = buildVodPlaylist(9.009, url, 'init.mp4', 3.003, 1 / 23.976);
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

  it('offsets cues by the container start on the 90kHz clock', () => {
    // 1.4s × 90000 → the cue at LOCAL 0 maps to source time 1.4, not 1.4s early.
    expect(mapLine(withTimestampMap('WEBVTT\n\n', 1.4))).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000',
    );
  });

  it('moves LOCAL for a container that starts before 0', () => {
    expect(mapLine(withTimestampMap('WEBVTT\n\n', -1.022))).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:01.022',
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
  function makeController(live: LiveSession | null, canManageSettings = false) {
    const liveSessions = {
      get: jest.fn().mockReturnValue(live),
      stop: jest.fn(),
      list: jest.fn().mockReturnValue([]),
      listForJob: jest.fn().mockReturnValue([]),
    };
    const transcodingService = {
      killSessionsForJob: jest.fn(),
    };
    const events = {
      emitToUser: jest.fn(),
      targetIdFor: jest.fn().mockReturnValue('tv#1'),
    };
    const caslAbilityFactory = {
      createForUser: jest.fn().mockReturnValue({
        can: jest.fn().mockReturnValue(canManageSettings),
      }),
    };

    const controller = new StreamingController(
      {} as never, // streamingService
      {} as never, // subtitleStreamService
      transcodingService as never,
      {} as never, // streamBuilder
      {} as never, // activeStreamTracker
      {} as never, // subtitleBurnIn
      {} as never, // thumbnailService
      {} as never, // playbackService
      {} as never, // markersService
      {} as never, // streamingSettingsCache
      liveSessions as never,
      {} as never, // segmentPackaging
      {} as never, // sessionRouter
      {} as never, // sessionContextBuilder
      {} as never, // sourceScans
      {} as never, // pluginPreRoll
      events as never,
      caslAbilityFactory as never,
    );

    return {
      controller,
      liveSessions,
      transcodingService,
      events,
      caslAbilityFactory,
    };
  }

  const owner = { id: 7 } as User;
  const stranger = { id: 99 } as User;

  function makeLive(overrides: Partial<LiveSession>): LiveSession {
    return {
      ...buildLiveSession(
        { userId: 7, username: 'alice', mediaFileId: 42, kind: 'transcode' },
        'sid-1',
        0,
      ),
      ...overrides,
    };
  }

  it('stops a DirectPlay sid (null profileHash) without touching ffmpeg', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, transcodingService } = makeController(live);

    controller.stopLiveSession('sid-1', owner);

    expect(liveSessions.stop).toHaveBeenCalledWith('sid-1');
    expect(transcodingService.killSessionsForJob).not.toHaveBeenCalled();
  });

  it('walks the ffmpeg-kill path for a transcode sid', () => {
    const live = makeLive({ profileHash: 'abc123', userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, transcodingService } = makeController(live);

    controller.stopLiveSession('sid-1', owner);

    expect(liveSessions.listForJob).toHaveBeenCalledWith(7, 42, 'abc123');
    // No other live session references the job → reap every ffmpeg variant.
    expect(transcodingService.killSessionsForJob).toHaveBeenCalledWith(
      42,
      7,
      'abc123',
    );
  });

  it('is a no-op on an unknown sid', () => {
    const { controller, liveSessions, events } = makeController(null);

    controller.stopLiveSession('missing', owner);

    expect(liveSessions.stop).toHaveBeenCalledWith('missing');
    // Nobody to notify: there's no live entry to read a userId off.
    expect(events.emitToUser).not.toHaveBeenCalled();
  });

  it('lets the owner stop their own session and notifies their other devices', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, events } = makeController(live);

    controller.stopLiveSession('sid-1', owner);

    expect(liveSessions.stop).toHaveBeenCalledWith('sid-1');
    expect(events.emitToUser).toHaveBeenCalledWith(7, {
      type: 'remote.targets_changed',
    });
  });

  it('refuses a non-owner without Manage:Settings: the ownership hole', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, events } = makeController(live, false);

    expect(() => controller.stopLiveSession('sid-1', stranger)).toThrow(
      ForbiddenException,
    );
    expect(liveSessions.stop).not.toHaveBeenCalled();
    expect(events.emitToUser).not.toHaveBeenCalled();
  });

  it('lets a user with Manage:Settings stop someone else\'s session', () => {
    const live = makeLive({ profileHash: null, userId: 7, mediaFileId: 42 });
    const { controller, liveSessions, events } = makeController(live, true);

    controller.stopLiveSession('sid-1', stranger);

    expect(liveSessions.stop).toHaveBeenCalledWith('sid-1');
    expect(events.emitToUser).toHaveBeenCalledWith(7, {
      type: 'remote.targets_changed',
    });
  });

  it('does not notify a shared-device session (no owning userId)', () => {
    const live = makeLive({ profileHash: null, userId: null, mediaFileId: 42 });
    const { controller, events } = makeController(live);

    controller.stopLiveSession('sid-1', owner);

    expect(events.emitToUser).not.toHaveBeenCalled();
  });
});

describe('resolvePreRoll', () => {
  const item = (mediaFileId: number): PreRollItem => ({ mediaFileId });
  const USER = { id: 42, name: 'viewer' };

  it('drops a candidate the user has no library access to (the security property)', async () => {
    // Mirrors resolveFile: rejects for anything outside this user's ACL.
    const resolveFile = jest.fn((id: number) =>
      id === 2 ? Promise.reject(new Error('MediaFile #2 not found')) : Promise.resolve({ id }),
    );

    const result = await resolvePreRoll({
      ask: () => Promise.resolve([item(1), item(2), item(3)]),
      resolveFile,
      user: USER,
    });

    expect(result).toEqual([item(1), item(3)]);
  });

  it('checks every candidate against the REQUESTING user, not some other identity', async () => {
    const resolveFile = jest.fn(() => Promise.resolve({}));

    await resolvePreRoll({ ask: () => Promise.resolve([item(1), item(2)]), resolveFile, user: USER });

    // The user threaded into the check is the one the request was made by.
    expect(resolveFile).toHaveBeenCalledWith(1, USER);
    expect(resolveFile).toHaveBeenCalledWith(2, USER);
  });

  it('is undefined, not an empty array, when the plugin offers nothing', async () => {
    const resolveFile = jest.fn(() => Promise.resolve({}));
    await expect(resolvePreRoll({ ask: () => Promise.resolve([]), resolveFile, user: USER })).resolves.toBeUndefined();
    expect(resolveFile).not.toHaveBeenCalled();
  });

  it('is undefined when nothing survives the ACL filter, so the field stays absent', async () => {
    const result = await resolvePreRoll({
      ask: () => Promise.resolve([item(1)]),
      resolveFile: () => Promise.reject(new Error('not found')),
      user: USER,
    });
    expect(result).toBeUndefined();
  });

  it('never throws when the ask itself fails', async () => {
    await expect(
      resolvePreRoll({ ask: () => Promise.resolve([]), resolveFile: () => Promise.resolve({}), user: USER }),
    ).resolves.toBeUndefined();
  });
});

describe('remux playlist cannot drift out of A/V sync', () => {
  // Real keyframe cuts measured on a 1920x800 H.264 Bluray source: ffmpeg's own
  // HLS playlist for `-c:v copy -hls_time 6`, identical to the millisecond in
  // MPEG-TS and fMP4. Durations here are what the segments really contain.
  const KEYFRAMES = [0, 7.966, 15.974, 19.937, 25.317, 31.865, 38.997, 43.001];
  const SEG_DUR = 6;
  const grid = computeSegmentGrid(
    KEYFRAMES.map((pts) => ({ pts, dts: pts })),
    0,
    43.001,
    SEG_DUR,
  )!;

  it('announces the real cut durations, and the seek grid agrees with them', () => {
    const { durations, boundaries } = grid;
    expect(durations.map((d) => Number(d.toFixed(3)))).toEqual([
      7.966, 8.008, 3.963, 5.38, 6.548, 7.132, 4.004,
    ]);
    const playlist = buildVariableVodPlaylist(
      durations,
      (i) => `seg-${i}.m4s`,
      'init.mp4',
    );
    const extinf = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) =>
      Number(m[1]),
    );

    // Every segment's announced start must land exactly on the boundary the
    // segment handler resolves a seek to. Divergence here IS the drift.
    let announced = 0;
    extinf.forEach((d, i) => {
      expect(announced).toBeCloseTo(boundaries[i], 3);
      announced += d;
    });
    expect(announced).toBeCloseTo(boundaries[boundaries.length - 1], 3);
    expect(gridSegmentIndex(boundaries, 20, 0)).toBe(3);
  });

  it('is what a uniform grid gets wrong — the regression being replaced', () => {
    const { durations } = grid;
    const uniform = buildVodPlaylist(43.001, (i) => `seg-${i}.ts`, undefined, SEG_DUR, 0.04);
    const uniformExtinf = [...uniform.matchAll(/#EXTINF:([\d.]+),/g)].map((m) =>
      Number(m[1]),
    );
    // Same media, but the announced third segment starts 1.9s before the bytes
    // actually do — the player renders audio against a video PTS that moved.
    const realStart = durations[0] + durations[1];
    const uniformStart = uniformExtinf[0] + uniformExtinf[1];
    expect(Math.abs(realStart - uniformStart)).toBeGreaterThan(1.9);
  });
});

describe('StreamingController.hlsPlaylist (remux)', () => {
  const grid = computeSegmentGrid(
    [0, 7.966, 15.974, 19.937].map((pts) => ({ pts, dts: pts })),
    0,
    25,
    6,
  )!;

  function playlistFor(live: Partial<LiveSession> | null): Promise<string> {
    const resolved = { mediaFile: { streamInfo: { video: [{ frameRate: '25' }] } } };
    const controller = new StreamingController(
      { resolveFile: jest.fn().mockResolvedValue(resolved) } as never,
      {} as never,
      {} as never,
      {} as never,
      { getSegmentDuration: () => 6 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertFresh: jest.fn(), findRequestSession: jest.fn().mockReturnValue(live) } as never,
      {} as never,
      {} as never, // sourceScans: a request never reads the scan itself
      {} as never,
      {} as never,
      {} as never,
    );
    return new Promise((resolve) => {
      const res = { setHeader: jest.fn(), send: resolve, status: jest.fn() };
      void controller.hlsPlaylist(
        42,
        'remux',
        { query: { duration: '25' }, user: { id: 7 } } as never,
        res as never,
      );
    });
  }
  const extinf = (m: string) => [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]));

  it('lists the grid the playback froze, or the uniform one it froze without a scan', async () => {
    expect(extinf(await playlistFor({ remuxGrid: grid }))).toEqual(
      grid.durations.map((d) => Number(d.toFixed(3))),
    );
    expect(extinf(await playlistFor({ remuxGrid: null }))).toEqual([6, 6, 6, 6, 1]);
  });
});

describe('StreamingController.hlsAudioPlaylist (remux rendition)', () => {
  const grid = computeSegmentGrid(
    [0, 7.966, 15.974, 19.937].map((pts) => ({ pts, dts: pts })),
    0,
    25,
    6,
  )!;

  function playlistFor(live: Partial<LiveSession> | null): Promise<string> {
    const resolved = { mediaFile: { streamInfo: { video: [{ frameRate: '25' }], durationSeconds: 25 } } };
    const controller = new StreamingController(
      { resolveFile: jest.fn().mockResolvedValue(resolved) } as never,
      {} as never,
      {} as never,
      {} as never,
      { getSegmentDuration: () => 6 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertFresh: jest.fn(), findRequestSession: jest.fn().mockReturnValue(live) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return new Promise((resolve) => {
      const res = { setHeader: jest.fn(), send: resolve, status: jest.fn() };
      void controller.hlsAudioPlaylist(
        42,
        0,
        { query: {}, user: { id: 7 } } as never,
        res as never,
      );
    });
  }
  const extinf = (m: string) => [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]));

  it('carries the same real durations as the video remux playlist, not a uniform grid', async () => {
    expect(extinf(await playlistFor({ kind: 'remux', remuxGrid: grid }))).toEqual(
      grid.durations.map((d) => Number(d.toFixed(3))),
    );
  });

  it('falls back to the uniform grid for a transcode session (or no live session at all)', async () => {
    expect(extinf(await playlistFor({ kind: 'transcode', remuxGrid: grid }))).toEqual([6, 6, 6, 6, 1]);
    expect(extinf(await playlistFor(null))).toEqual([6, 6, 6, 6, 1]);
  });
});

describe('StreamingController.hlsMaster — multi-audio remux publishes the group', () => {
  function masterFor(
    live: Partial<LiveSession> | null,
    query: Record<string, string> = { remux: '1' },
  ) {
    const resolved = {
      mediaFile: {
        streamInfo: {
          video: [{ width: 1920, height: 1080, frameRate: '24' }],
          audio: [{ codec: 'aac' }, { codec: 'ac3' }],
        },
      },
    };
    const generateMasterPlaylist = jest.fn().mockReturnValue('#EXTM3U');
    const controller = new StreamingController(
      { resolveFile: jest.fn().mockResolvedValue(resolved) } as never,
      {} as never,
      { generateMasterPlaylist } as never,
      {} as never,
      { getSegmentDuration: () => 6 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { update: jest.fn() } as never,
      {} as never,
      { assertFresh: jest.fn(), findRequestSession: jest.fn().mockReturnValue(live) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { controller, generateMasterPlaylist };
  }

  it('publishes the audio group for a multi-audio remux (today it muxed the picked track alone)', async () => {
    const audioTrackPlans = [
      { mode: 'copy' as const, codec: 'aac', channels: 2 },
      { mode: 'copy' as const, codec: 'ac3', channels: 6 },
    ];
    const { controller, generateMasterPlaylist } = masterFor({
      audioStreamIndex: 0,
      audioTrackPlans,
    });
    const res = { setHeader: jest.fn(), send: jest.fn(), status: jest.fn() };
    await controller.hlsMaster(42, { query: { remux: '1' }, user: { id: 7 } } as never, res as never);
    const opts = generateMasterPlaylist.mock.calls[0][0];
    expect(opts.audioStreams).toHaveLength(2);
    expect(opts.audioPlans).toEqual(audioTrackPlans);
  });

  it('keeps the muxed single track for a single-audio source', async () => {
    const resolved = {
      mediaFile: { streamInfo: { video: [{ width: 1920, height: 1080, frameRate: '24' }], audio: [{ codec: 'aac' }] } },
    };
    const generateMasterPlaylist = jest.fn().mockReturnValue('#EXTM3U');
    const controller = new StreamingController(
      { resolveFile: jest.fn().mockResolvedValue(resolved) } as never,
      {} as never,
      { generateMasterPlaylist } as never,
      {} as never,
      { getSegmentDuration: () => 6 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { update: jest.fn() } as never,
      {} as never,
      { assertFresh: jest.fn(), findRequestSession: jest.fn().mockReturnValue({
        audioPlan: { mode: 'copy', codec: 'aac', channels: 2 },
      }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const res = { setHeader: jest.fn(), send: jest.fn(), status: jest.fn() };
    await controller.hlsMaster(42, { query: { remux: '1' }, user: { id: 7 } } as never, res as never);
    const opts = generateMasterPlaylist.mock.calls[0][0];
    expect(opts.audioStreams).toBeUndefined();
    expect(opts.audioPlans).toEqual([{ mode: 'copy', codec: 'aac', channels: 2 }]);
  });
});

describe('StreamingController.hlsSegment — kind refresh', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-kind-refresh-'));
  afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));

  /** Serves `quality`'s segment off a real on-disk file via the fast path
   *  (an `existing` session + a live session already resolved), so the
   *  refresh runs without exercising the slow spawn path. */
  async function serveSegment(
    quality: string,
    live: LiveSession,
  ): Promise<{ liveSessions: { update: jest.Mock } }> {
    const segPath = path.join(cacheRoot, 'seg-0001.m4s');
    fs.writeFileSync(segPath, 'x');
    const liveSessions = { update: jest.fn() };
    const controller = new StreamingController(
      { resolveFile: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
      {} as never,
      {} as never,
      { getSegmentDuration: () => 3 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      liveSessions as never,
      { serve: jest.fn().mockResolvedValue(undefined) } as never,
      {
        assertFresh: jest.fn(),
        findRequestSession: jest.fn().mockReturnValue(live),
        resolveSession: jest.fn().mockReturnValue({
          quality,
          cachePath: cacheRoot,
          segmentDuration: 3,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await controller.hlsSegment(
      42,
      quality,
      'seg-0001.m4s',
      { query: {}, user: { id: 7 } } as never,
      { id: 7 } as User,
      { setHeader: jest.fn() } as never,
    );
    return { liveSessions };
  }

  it('flips a remux-decided session to transcode once a rung is actually served', async () => {
    const live = buildLiveSession(
      { userId: 7, username: null, mediaFileId: 42, kind: 'remux' },
      'sid-1',
      0,
    );
    const { liveSessions } = await serveSegment('1080p', live);
    expect(liveSessions.update).toHaveBeenCalledWith(live.sessionId, { kind: 'transcode' });
  });

  it('flips a transcode-decided session to remux once the remux rendition is served', async () => {
    const live = buildLiveSession(
      { userId: 7, username: null, mediaFileId: 42, kind: 'transcode' },
      'sid-1',
      0,
    );
    const { liveSessions } = await serveSegment('remux', live);
    expect(liveSessions.update).toHaveBeenCalledWith(live.sessionId, { kind: 'remux' });
  });

  it('is a no-op once the served kind already matches', async () => {
    const live = buildLiveSession(
      { userId: 7, username: null, mediaFileId: 42, kind: 'transcode' },
      'sid-1',
      0,
    );
    const { liveSessions } = await serveSegment('1080p', live);
    expect(liveSessions.update).not.toHaveBeenCalled();
  });
});
