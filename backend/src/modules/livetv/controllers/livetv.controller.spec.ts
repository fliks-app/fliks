import { NotFoundException } from '@nestjs/common';
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
    const sessions = {
      getForServe: jest
        .fn()
        .mockReturnValue({ channelId: 42, dir: '/tmp/does-not-matter' }),
    };
    const controller = new LivetvController(
      channels as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
    );
    const req = { query: {} } as unknown as Request;
    const res = {} as Response;

    await expect(
      controller.servePlaylist('sess-1', user, req, res),
    ).rejects.toThrow(NotFoundException);
    expect(findPlayable).toHaveBeenCalledWith(42, user);
  });

  it('re-runs the access check before attaching a direct-mode viewer', async () => {
    const findPlayable = jest.fn().mockRejectedValue(new NotFoundException());
    const channels = { findPlayable };
    const attachDirectViewer = jest.fn();
    const sessions = {
      getForServe: jest.fn().mockReturnValue({ channelId: 7, mode: 'direct' }),
      attachDirectViewer,
    };
    const controller = new LivetvController(
      channels as never,
      {} as never,
      sessions as never,
      {} as never,
      {} as never,
    );
    const res = {} as Response;

    await expect(controller.serveDirect('sess-2', user, res)).rejects.toThrow(
      NotFoundException,
    );
    expect(attachDirectViewer).not.toHaveBeenCalled();
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
    );
    const res = {} as Response;

    await expect(
      controller.serveLogo(5, undefined, user, res),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getDiskPath).not.toHaveBeenCalled();
  });
});
