import { PlaybackController } from './playback.controller';

/**
 * `updateState` only needs the playback service and the live-session
 * registry, so we exercise it on a bare prototype instance. The contract
 * under test: DB writes are debounced to one per 30 s, but a seek flushes
 * immediately — otherwise quitting right after a jump loses the position.
 */
function buildController(liveSessionsOverrides?: Record<string, unknown>) {
  const controller = Object.create(
    PlaybackController.prototype,
  ) as PlaybackController;
  const updateState = jest.fn(async () => ({ id: 1 }));
  const emitToUser = jest.fn();
  const wired = controller as unknown as {
    playbackService: unknown;
    liveSessions: unknown;
    events: unknown;
    lastDbWriteAt: Map<string, { at: number; pos: number }>;
    log: { debug: jest.Mock };
  };
  wired.playbackService = { updateState };
  wired.liveSessions = {
    get: () => null,
    heartbeat: () => null,
    ...liveSessionsOverrides,
  };
  wired.events = { emitToUser, targetIdFor: () => null };
  wired.lastDbWriteAt = new Map();
  wired.log = { debug: jest.fn() };
  return { controller, updateState, emitToUser };
}

const req = { user: { id: 7 }, get: () => undefined } as never;
const tick = (positionSeconds: number) => ({
  positionSeconds,
  durationSeconds: 6000,
  mediaFileId: 9,
});

describe('PlaybackController.updateState — DB flush gating', () => {
  it('debounces a plain 10 s playback tick', async () => {
    const { controller, updateState } = buildController();
    await controller.updateState(req, 3, tick(1800));
    const res = await controller.updateState(req, 3, tick(1810));
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(res).toBeNull();
  });

  it('flushes a seek within the debounce window', async () => {
    const { controller, updateState } = buildController();
    await controller.updateState(req, 3, tick(1800));
    const res = await controller.updateState(req, 3, tick(1920));
    expect(updateState).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ state: { id: 1 } });
  });
});

/**
 * The heartbeat is also the `remote.state` fan-out: the whole point of the
 * feature is a controller learning the target's state on the same 10 s beat
 * that already flows here, not gated on the DB-flush debounce below it.
 */
describe('PlaybackController.updateState: remote.state fan-out', () => {
  const sessionTick = (overrides: Record<string, unknown> = {}) => ({
    positionSeconds: 120,
    durationSeconds: 6000,
    mediaFileId: 9,
    sessionId: 'sid-1',
    ...overrides,
  });

  const fakeSession = (overrides: Record<string, unknown> = {}) => ({
    sseConnectionId: 'conn-1',
    mediaTitle: 'Title',
    posterUrl: null,
    position: 120,
    state: 'playing',
    volume: 0.8,
    muted: false,
    quality: '1080p',
    audioTrackIndex: 0,
    subtitleTrackIndex: null,
    ...overrides,
  });

  it('emits remote.state on every heartbeat, not just on a DB flush', async () => {
    const heartbeat = jest.fn(() => fakeSession());
    const { controller, emitToUser } = buildController({ heartbeat });
    (controller as unknown as { events: { targetIdFor(): string } }).events.targetIdFor =
      () => 'target-1';

    // Two heartbeats inside the 30 s debounce window: the second would be a
    // DB no-op (`updateState` returns null), yet the state event must still fire.
    await controller.updateState(req, 3, sessionTick());
    await controller.updateState(req, 3, sessionTick({ positionSeconds: 130 }));

    expect(emitToUser).toHaveBeenCalledTimes(2);
    expect(emitToUser).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        type: 'remote.state',
        targetId: 'target-1',
        sessionId: 'sid-1',
        mediaId: 3,
        volume: 0.8,
        muted: false,
        lastCmdId: null,
      }),
    );
  });

  it('skips the emit and logs when the stored connection resolves to no live target', async () => {
    const heartbeat = jest.fn(() => fakeSession());
    const { controller, emitToUser } = buildController({ heartbeat });
    // buildController's default events.targetIdFor() returns null: the
    // reconnect-backoff window where the stored sseConnectionId is stale.

    await controller.updateState(req, 3, sessionTick());

    expect(emitToUser).not.toHaveBeenCalled();
    expect(
      (controller as unknown as { log: { debug: jest.Mock } }).log.debug,
    ).toHaveBeenCalled();
  });

  it('does not emit when the session is unknown to the registry', async () => {
    const { controller, emitToUser } = buildController({ heartbeat: () => null });

    await controller.updateState(req, 3, sessionTick());

    expect(emitToUser).not.toHaveBeenCalled();
  });
});
