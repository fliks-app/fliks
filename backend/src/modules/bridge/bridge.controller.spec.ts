import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { BridgeAuthGuard } from './bridge-auth.guard';
import { BridgeController } from './bridge.controller';

const ctx = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  }) as unknown as ExecutionContext;

describe('BridgeAuthGuard', () => {
  const guard = new BridgeAuthGuard();
  const saved = process.env.FLIKS_BRIDGE_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLIKS_BRIDGE_TOKEN;
    else process.env.FLIKS_BRIDGE_TOKEN = saved;
  });

  it('answers 503 when the token env is missing', () => {
    delete process.env.FLIKS_BRIDGE_TOKEN;
    expect(() => guard.canActivate(ctx('Bearer x'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it.each([
    undefined,
    'Bearer nope',
    'Bearer secret-longer',
    'secret',
    'Bearer ',
  ])('rejects %s', (h) => {
    process.env.FLIKS_BRIDGE_TOKEN = 'secret';
    expect(() => guard.canActivate(ctx(h))).toThrow(UnauthorizedException);
  });

  it('accepts the exact bearer token', () => {
    process.env.FLIKS_BRIDGE_TOKEN = 'secret';
    expect(guard.canActivate(ctx('Bearer secret'))).toBe(true);
  });
});

describe('BridgeController', () => {
  const events = {
    emitToUser: jest.fn(),
    dropConnectionsForUser: jest.fn(),
    dropConnectionsForTarget: jest.fn(),
  };
  const settings = { notifyChange: jest.fn() };
  const engine = { reconfigure: jest.fn() };
  const controller = new BridgeController(
    events as never,
    settings as never,
    engine as never,
  );
  beforeEach(() => jest.clearAllMocks());

  it('emits pairing.requested to the target user only', () => {
    const dto = {
      event: 'pairing.requested' as const,
      userId: 7,
      pairingId: 'p',
      deviceName: 'TV',
      deviceId: 'd',
    };
    controller.emit(dto);
    expect(events.emitToUser).toHaveBeenCalledWith(7, {
      type: 'pairing.requested',
      userId: 7,
      pairingId: 'p',
      deviceName: 'TV',
      deviceId: 'd',
    });
  });

  it('drops the whole account without a targetId, one device with it', () => {
    controller.dropConnections({ userId: 3 });
    expect(events.dropConnectionsForUser).toHaveBeenCalledWith(3);
    controller.dropConnections({ userId: 3, targetId: 't' });
    expect(events.dropConnectionsForTarget).toHaveBeenCalledWith(3, 't');
  });

  it('notifies each key in order with the origin, without re-adopting', async () => {
    await controller.settingsChanged({ keys: ['a', 'b'], origin: 'plug' });
    expect(settings.notifyChange.mock.calls).toEqual([
      ['a', 'plug'],
      ['b', 'plug'],
    ]);
    expect(engine.reconfigure).not.toHaveBeenCalled();
  });

  it('re-adopts the engine when its url or token changed', async () => {
    await controller.settingsChanged({ keys: ['engine_token'] });
    expect(engine.reconfigure).toHaveBeenCalledTimes(1);
  });
});
