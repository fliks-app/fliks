import { PlaybackController } from './playback.controller';

/**
 * `updateState` only needs the playback service and the live-session
 * registry, so we exercise it on a bare prototype instance. The contract
 * under test: DB writes are debounced to one per 30 s, but a seek flushes
 * immediately — otherwise quitting right after a jump loses the position.
 */
function buildController() {
  const controller = Object.create(
    PlaybackController.prototype,
  ) as PlaybackController;
  const updateState = jest.fn(async () => ({ id: 1 }));
  const wired = controller as unknown as {
    playbackService: unknown;
    liveSessions: unknown;
    lastDbWriteAt: Map<string, { at: number; pos: number }>;
  };
  wired.playbackService = { updateState };
  wired.liveSessions = { get: () => null, heartbeat: () => null };
  wired.lastDbWriteAt = new Map();
  return { controller, updateState };
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
