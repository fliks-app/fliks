import {
  StreamingController,
  resolveAudioStreamIndex,
  resolvePreRoll,
} from './streaming.controller';
import { buildLiveSession, type LiveSession } from './live-session.service';
import type { PreRollItem } from '../../common/plugin-contract';
import type { User } from '../users/entities/user.entity';
import { ForbiddenException } from '@nestjs/common';

/** Every constructor slot of {@link StreamingController} defaults to `{}`;
 *  a test overrides only the collaborators it actually exercises. */
interface ControllerDeps {
  streamingService?: unknown;
  hardware?: unknown;
  streamingSettingsCache?: unknown;
  liveSessions?: unknown;
  events?: unknown;
  caslAbilityFactory?: unknown;
  engine?: unknown;
  enginePlayback?: unknown;
}

function makeController(deps: ControllerDeps = {}): StreamingController {
  return new StreamingController(
    (deps.streamingService ?? {}) as never,
    (deps.hardware ?? {}) as never,
    (deps.streamingSettingsCache ?? {}) as never,
    (deps.liveSessions ?? {}) as never,
    (deps.events ?? {}) as never,
    (deps.caslAbilityFactory ?? {}) as never,
    (deps.engine ?? {}) as never,
    (deps.enginePlayback ?? {}) as never,
  );
}

describe('StreamingController DELETE sessions/:sid', () => {
  const owner = { id: 7 } as User;
  const stranger = { id: 99 } as User;
  const live = (over: Partial<LiveSession> = {}): LiveSession => ({
    ...buildLiveSession(
      {
        userId: 7,
        username: 'alice',
        mediaFileId: 42,
        kind: 'transcode',
        profileHash: 'abc',
      },
      'sid-1',
      0,
    ),
    ...over,
  });

  function setup(
    presence: LiveSession | null,
    snapshotOwner: string | null = null,
    canManage = false,
  ) {
    const liveSessions = {
      peek: jest.fn().mockReturnValue(presence),
      stop: jest.fn(),
    };
    const engine = {
      runtime: true,
      deleteSession: jest.fn().mockResolvedValue(undefined),
      getSession: jest
        .fn()
        .mockResolvedValue(snapshotOwner ? { ownerId: snapshotOwner } : null),
    };
    const events = {
      emitToUser: jest.fn(),
      targetIdFor: jest.fn().mockReturnValue('tv#1'),
    };
    const caslAbilityFactory = {
      createForUser: () => ({ can: () => canManage }),
    };
    const controller = makeController({
      liveSessions,
      events,
      caslAbilityFactory,
      engine,
    });
    return { controller, liveSessions, engine, events };
  }

  it('ends the presence, then the engine session', async () => {
    const { controller, liveSessions, engine } = setup(live());
    await controller.stopLiveSession('sid-1', owner);
    expect(liveSessions.stop).toHaveBeenCalledWith('sid-1');
    expect(engine.deleteSession).toHaveBeenCalledWith('sid-1');
  });

  it('lets the owner stop their own session and tells their other devices', async () => {
    const { controller, events } = setup(live());
    await controller.stopLiveSession('sid-1', owner);
    expect(events.emitToUser).toHaveBeenCalledWith(7, {
      type: 'remote.stopped',
      targetId: 'tv#1',
    });
    expect(events.emitToUser).toHaveBeenCalledWith(7, {
      type: 'remote.targets_changed',
    });
  });

  it('refuses a non-owner without Manage:Settings before anything is deleted', async () => {
    const { controller, liveSessions, engine, events } = setup(live());
    await expect(controller.stopLiveSession('sid-1', stranger)).rejects.toThrow(
      ForbiddenException,
    );
    expect(liveSessions.stop).not.toHaveBeenCalled();
    expect(engine.deleteSession).not.toHaveBeenCalled();
    expect(events.emitToUser).not.toHaveBeenCalled();
  });

  it("lets Manage:Settings stop another user's session", async () => {
    const { controller, engine } = setup(live(), null, true);
    await controller.stopLiveSession('sid-1', stranger);
    expect(engine.deleteSession).toHaveBeenCalledWith('sid-1');
  });

  it('does not notify a shared-device session (no owning userId)', async () => {
    const { controller, events } = setup(live({ userId: null }));
    await controller.stopLiveSession('sid-1', owner);
    expect(events.emitToUser).not.toHaveBeenCalled();
  });

  it('takes the owner from the engine when the host holds no presence', async () => {
    const gone = setup(null, '7');
    await gone.controller.stopLiveSession('sid-1', owner);
    expect(gone.engine.deleteSession).toHaveBeenCalledWith('sid-1');

    const foreign = setup(null, '7');
    await expect(
      foreign.controller.stopLiveSession('sid-1', stranger),
    ).rejects.toThrow(ForbiddenException);
    expect(foreign.engine.deleteSession).not.toHaveBeenCalled();
  });

  it('stays idempotent for a sid nobody knows, and when the engine cannot be reached', async () => {
    const { controller, engine } = setup(null, null);
    engine.deleteSession.mockRejectedValue(new Error('down'));
    await expect(
      controller.stopLiveSession('nope', owner),
    ).resolves.toBeUndefined();
    expect(engine.deleteSession).toHaveBeenCalledWith('nope');
  });
});

describe('StreamingController POST :id/playback-info', () => {
  const owner = { id: 7 } as User;
  const request = (query: object) =>
    ({
      user: owner,
      query,
      get: (h: string) =>
        ({ 'x-fliks-sse-connection': 'conn-1', 'user-agent': 'UA' })[h],
    }) as never;

  it('hands the request to the engine orchestrator', async () => {
    const enginePlayback = {
      playbackInfo: jest.fn().mockResolvedValue({ sessionId: 'x' }),
    };
    const c = makeController({ enginePlayback });
    const device = { directPlayProfiles: [] } as never;

    const out = await c.playbackInfo(
      42,
      device,
      request({
        token: 'tok',
        sid: 'old',
        burnInSubtitleId: '12',
        audioStreamIndex: '1',
        startQuality: '720p',
        startAt: '33.5',
        download: '1',
      }),
    );

    expect(out).toEqual({ sessionId: 'x' });
    expect(enginePlayback.playbackInfo).toHaveBeenCalledWith(
      owner,
      42,
      device,
      {
        tokenParam: '?token=tok&sid=old',
        burnInSubtitleId: 12,
        audioStreamIndex: '1',
        startQuality: '720p',
        startAt: 33.5,
        download: true,
        sseConnectionId: 'conn-1',
        userAgent: 'UA',
      },
    );
  });
});

describe('StreamingController.downloadQualities', () => {
  it("asks the engine for the sizes of the file's rungs", async () => {
    const info = { durationSeconds: 60 };
    const streamingService = {
      resolveFile: jest
        .fn()
        .mockResolvedValue({ size: 1234, mediaFile: { streamInfo: info } }),
    };
    const estimates = [{ key: '720p', label: '720p', estimatedSize: 100 }];
    const engine = { estimateSizes: jest.fn().mockResolvedValue(estimates) };
    const c = makeController({ streamingService, engine });
    await expect(
      c.downloadQualities({ user: { id: 7 } } as never, 42),
    ).resolves.toBe(estimates);
    expect(engine.estimateSizes).toHaveBeenCalledWith(info, 1234);
  });
});

describe('resolvePreRoll', () => {
  const item = (mediaFileId: number): PreRollItem => ({ mediaFileId });
  const USER = { id: 42, name: 'viewer' };

  it('drops a candidate the user has no library access to (the security property)', async () => {
    // Mirrors resolveFile: rejects for anything outside this user's ACL.
    const resolveFile = jest.fn((id: number) =>
      id === 2
        ? Promise.reject(new Error('MediaFile #2 not found'))
        : Promise.resolve({ id }),
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

    await resolvePreRoll({
      ask: () => Promise.resolve([item(1), item(2)]),
      resolveFile,
      user: USER,
    });

    // The user threaded into the check is the one the request was made by.
    expect(resolveFile).toHaveBeenCalledWith(1, USER);
    expect(resolveFile).toHaveBeenCalledWith(2, USER);
  });

  it('is undefined, not an empty array, when the plugin offers nothing', async () => {
    const resolveFile = jest.fn(() => Promise.resolve({}));
    await expect(
      resolvePreRoll({
        ask: () => Promise.resolve([]),
        resolveFile,
        user: USER,
      }),
    ).resolves.toBeUndefined();
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
      resolvePreRoll({
        ask: () => Promise.resolve([]),
        resolveFile: () => Promise.resolve({}),
        user: USER,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('resolveAudioStreamIndex', () => {
  it.each([
    ['1', 2, 1],
    ['2', 2, undefined],
    ['-1', 2, undefined],
    ['abc', 2, undefined],
    ['0', 0, undefined],
    [undefined, 2, undefined],
  ])('%s of %i tracks -> %s', (raw, count, expected) => {
    expect(resolveAudioStreamIndex(raw, count)).toBe(expected);
  });
});
