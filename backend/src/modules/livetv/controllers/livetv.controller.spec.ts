import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LivetvController, SEGMENT_NAME_RE } from './livetv.controller';
import { SessionTokenGuard } from '../../auth/guards/session-token.guard';
import type { User } from '../../users/entities/user.entity';

describe('SEGMENT_NAME_RE', () => {
  it("accepts a segment past ffmpeg's 5-digit padding, since %05d is a minimum width", () => {
    expect(SEGMENT_NAME_RE.test('seg-100000.m4s')).toBe(true);
    expect(SEGMENT_NAME_RE.test('seg-100000.ts')).toBe(true);
  });

  it('still accepts a normal segment and the init segment', () => {
    expect(SEGMENT_NAME_RE.test('seg-00000.m4s')).toBe(true);
    expect(SEGMENT_NAME_RE.test('init.mp4')).toBe(true);
  });

  it('rejects a name that only pretends to be a segment', () => {
    expect(SEGMENT_NAME_RE.test('../../etc/passwd')).toBe(false);
    expect(SEGMENT_NAME_RE.test('seg-abcde.m4s')).toBe(false);
  });
});

/** A viewer's manifest/direct request is served through a session token, not
 *  the user's own — so a revoked route must reject it via `SessionTokenGuard`
 *  metadata, the same way `PluginBackupController` proves its guard. */
function guardsFor(method: 'play' | 'leave' | 'setPrefs'): unknown[] {
  return (Reflect.getMetadata(
    '__guards__',
    LivetvController.prototype[method],
  ) ?? []) as unknown[];
}

describe('LivetvController — revocation reaches an in-progress session', () => {
  const user = { id: 1 } as User;

  it('re-runs the same play-time access check on every manifest poll', async () => {
    const findPlayable = jest.fn().mockRejectedValue(new NotFoundException());
    const channels = { findPlayable };
    const leave = jest.fn().mockResolvedValue(undefined);
    const sessions = {
      getForServe: jest
        .fn()
        .mockReturnValue({ channelId: 42, dir: '/tmp/does-not-matter' }),
      leave,
    };
    const controller = new LivetvController(
      channels as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = { query: {} } as unknown as Request;
    const res = {} as Response;

    await expect(
      controller.servePlaylist('sess-1', user, req, res),
    ).rejects.toThrow(NotFoundException);
    expect(findPlayable).toHaveBeenCalledWith(42, user);
    // A failed re-check must not leave this viewer registered: serveSegment never re-checks.
    expect(leave).toHaveBeenCalledWith('sess-1');
  });

  it('re-runs the access check before attaching a direct-mode viewer', async () => {
    const findPlayable = jest.fn().mockRejectedValue(new NotFoundException());
    const channels = { findPlayable };
    const attachDirectViewer = jest.fn();
    const leave = jest.fn().mockResolvedValue(undefined);
    const sessions = {
      getForServe: jest.fn().mockReturnValue({ channelId: 7, mode: 'direct' }),
      attachDirectViewer,
      leave,
    };
    const controller = new LivetvController(
      channels as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const res = {} as Response;

    await expect(controller.serveDirect('sess-2', user, res)).rejects.toThrow(
      NotFoundException,
    );
    expect(attachDirectViewer).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith('sess-2');
  });

  it.each(['play' as const, 'leave' as const, 'setPrefs' as const])(
    'rejects a stream-scoped token on %s',
    (method) => {
      expect(guardsFor(method)).toContain(SessionTokenGuard);
    },
  );
});

describe('LivetvController — channel logo', () => {
  const user = { id: 1 } as User;

  it('answers not found for a restricted channel the caller cannot see, without touching the disk', async () => {
    const assertVisible = jest
      .fn()
      .mockRejectedValue(new NotFoundException('Live TV channel #5 not found'));
    const channels = { assertVisible };
    const getDiskPath = jest.fn();
    const controller = new LivetvController(
      channels as never,
      {} as never,
      {} as never,
      {} as never,
      { getDiskPath } as never,
      {} as never,
    );
    const res = {} as Response;

    await expect(
      controller.serveLogo(5, undefined, user, res),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getDiskPath).not.toHaveBeenCalled();
  });
});

describe('LivetvController — QoE heartbeat', () => {
  const user = { id: 1 } as User;
  const sample = { engine: 'shaka', cmcd: true, stallCount: 2 };
  const build = (ref: unknown) => {
    const recordSample = jest.fn();
    const controller = new LivetvController(
      {} as never,
      {} as never,
      { qoeRef: jest.fn().mockReturnValue(ref) } as never,
      {} as never,
      {} as never,
      { recordSample } as never,
    );
    return { controller, recordSample };
  };

  it('stores the validated sample of the owner', () => {
    const ref = { sessionId: 's', userId: 1 };
    const { controller, recordSample } = build(ref);
    expect(controller.heartbeat('s', { qoe: sample }, user)).toEqual({ ok: true });
    expect(recordSample).toHaveBeenCalledWith(
      { ...ref, state: 'playing' },
      expect.objectContaining({ engine: 'shaka', cmcd: true, stallCount: 2 }),
    );
  });

  it('maps the player paused state to the tracker', () => {
    const { controller, recordSample } = build({ sessionId: 's', userId: 1, state: 'playing' });
    controller.heartbeat('s', { qoe: sample, state: 'paused' }, user);
    expect(recordSample).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }), expect.anything());
  });

  it('ignores a sample that fails validation', () => {
    const { controller, recordSample } = build({ sessionId: 's', userId: 1 });
    controller.heartbeat('s', { qoe: { engine: 'nope' } }, user);
    expect(recordSample).not.toHaveBeenCalled();
  });

  it("rejects another user's session", () => {
    const { controller, recordSample } = build({ sessionId: 's', userId: 2 });
    expect(() => controller.heartbeat('s', { qoe: sample }, user)).toThrow(ForbiddenException);
    expect(recordSample).not.toHaveBeenCalled();
  });

  it('answers not found for an unknown session', () => {
    const { controller } = build(null);
    expect(() => controller.heartbeat('s', {}, user)).toThrow(NotFoundException);
  });

  it('requires a stream-scoped session token', () => {
    expect(
      Reflect.getMetadata('__guards__', LivetvController.prototype.heartbeat),
    ).toContain(SessionTokenGuard);
  });
});
