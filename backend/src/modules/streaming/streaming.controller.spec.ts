import {
  StreamingController,
  withTimestampMap,
  buildVodPlaylist,
  buildVariableVodPlaylist,
  buildIFramePlaylist,
  resolvePreRoll,
} from './streaming.controller';
import {
  boundariesFromDurations,
  computeSegmentDurations,
  secondsToSegmentIndex,
} from './transcoding/segment-boundaries';
import { buildLiveSession, type LiveSession } from './live-session.service';
import type { PreRollItem } from '../../common/plugin-contract';
import type { User } from '../users/entities/user.entity';
import { ForbiddenException } from '@nestjs/common';

describe('buildIFramePlaylist', () => {
  const url = (i: string): string => `iframe/seg-${i}.ts`;

  it('declares I-frames-only and no init segment', () => {
    const m = buildIFramePlaylist(12, url, 4);
    expect(m).toContain('#EXT-X-I-FRAMES-ONLY');
    expect(m).not.toContain('#EXT-X-MAP');
  });

  it('keeps one entry per grid keyframe', () => {
    const m = buildIFramePlaylist(12, url, 4);
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

  it('announces the real cut durations, and the seek grid agrees with them', () => {
    const durations = computeSegmentDurations(KEYFRAMES, 43.001, SEG_DUR);
    expect(durations.map((d) => Number(d.toFixed(3)))).toEqual([
      7.966, 8.008, 3.963, 5.38, 6.548, 7.132, 4.004,
    ]);

    const boundaries = boundariesFromDurations(durations, KEYFRAMES[0]);
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
    expect(secondsToSegmentIndex(boundaries, 20)).toBe(3);
  });

  it('is what a uniform grid gets wrong — the regression being replaced', () => {
    const durations = computeSegmentDurations(KEYFRAMES, 43.001, SEG_DUR);
    const uniform = buildVodPlaylist(43.001, (i) => `seg-${i}.ts`, undefined, SEG_DUR);
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
