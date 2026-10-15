import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { LivetvController } from './livetv.controller';
import { SessionTokenGuard } from '../../auth/guards/session-token.guard';
import type { User } from '../../users/entities/user.entity';

/** The state-changing routes must reject a stream-scoped token via `SessionTokenGuard`
 *  metadata, the same way `PluginBackupController` proves its guard. */
function guardsFor(method: 'play' | 'leave' | 'setPrefs'): unknown[] {
  return (Reflect.getMetadata(
    '__guards__',
    LivetvController.prototype[method],
  ) ?? []) as unknown[];
}

describe('LivetvController — session token scope', () => {
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

  it('forwards the raw sample of the owner', () => {
    const ref = { sessionId: 's', userId: 1 };
    const { controller, recordSample } = build(ref);
    expect(controller.heartbeat('s', { qoe: sample }, user)).toEqual({ ok: true });
    expect(recordSample).toHaveBeenCalledWith(
      { ...ref, state: 'playing' },
      sample,
    );
  });

  it('maps the player paused state to the tracker', () => {
    const { controller, recordSample } = build({ sessionId: 's', userId: 1, state: 'playing' });
    controller.heartbeat('s', { qoe: sample, state: 'paused' }, user);
    expect(recordSample).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }), expect.anything());
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
