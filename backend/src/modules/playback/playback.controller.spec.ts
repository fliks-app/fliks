import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EngineError } from '../engine/engine.service';
import { LiveSessionRegistry } from '../streaming/live-session.service';
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
    log: { debug: jest.Mock; warn: jest.Mock };
  };
  wired.playbackService = { updateState };
  wired.liveSessions = {
    peek: () => null,
    heartbeat: () => null,
    ...liveSessionsOverrides,
  };
  wired.events = { emitToUser, targetIdFor: () => null };
  wired.lastDbWriteAt = new Map();
  wired.log = { debug: jest.fn(), warn: jest.fn() };
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

describe('PlaybackController.postQoeEvents', () => {
  function build(live: unknown, enabled = true, tracked: unknown = null) {
    const controller = Object.create(PlaybackController.prototype) as PlaybackController;
    const recordEvents = jest.fn();
    Object.assign(controller, {
      liveSessions: { peek: () => live },
      qoe: { enabled, recordEvents, trackedSession: () => tracked },
    });
    return { controller, recordEvents };
  }
  const body = { events: [{ type: 'stall', at: 1 }, { type: 'nope', at: 1 }] };

  it('records validated events for the owner', () => {
    const { controller, recordEvents } = build({ userId: 7, attributedUserId: null });
    controller.postQoeEvents(req, 's', body);
    expect(recordEvents).toHaveBeenCalledWith(expect.anything(), [
      { type: 'stall', at: expect.any(Number), position: null },
    ], null);
  });

  it('passes a valid playbackId and drops a malformed one', () => {
    const { controller, recordEvents } = build({ userId: 7, attributedUserId: null });
    controller.postQoeEvents(req, 's', { ...body, playbackId: 'abc-123' });
    expect(recordEvents.mock.calls[0][2]).toBe('abc-123');
    controller.postQoeEvents(req, 's', { ...body, playbackId: 'x'.repeat(65) });
    expect(recordEvents.mock.calls[1][2]).toBeNull();
  });

  it('accepts the attributed user, rejects anyone else', () => {
    expect(() =>
      build({ userId: 9, attributedUserId: 7 }).controller.postQoeEvents(req, 's', body),
    ).not.toThrow();
    expect(() =>
      build({ userId: 9, attributedUserId: 8 }).controller.postQoeEvents(req, 's', body),
    ).toThrow('Not your session');
  });

  it('accepts events for an ended session whose tracker is kept, for its owner only', () => {
    const ended = { userId: 7, attributedUserId: null };
    const ok = build(null, true, ended);
    ok.controller.postQoeEvents(req, 's', body);
    expect(ok.recordEvents).toHaveBeenCalledWith(ended, expect.any(Array), null);
    expect(() =>
      build(null, true, { userId: 9, attributedUserId: null }).controller.postQoeEvents(req, 's', body),
    ).toThrow('Not your session');
  });

  it('ignores an unknown session and a disabled feature', () => {
    expect(build(null).recordEvents).not.toHaveBeenCalled();
    const off = build({ userId: 7 }, false);
    off.controller.postQoeEvents(req, 's', body);
    expect(off.recordEvents).not.toHaveBeenCalled();
  });
});

describe('PlaybackController.updateState: qoe bitrate fallback', () => {
  const sample = { engine: 'webos', variantBitrate: null };
  async function beat(session: Record<string, unknown>, qoe: object = sample) {
    const { controller } = buildController({ heartbeat: () => session });
    const recordSample = jest.fn();
    (controller as unknown as { qoe: unknown }).qoe = { recordSample, updatePipelineOutput: jest.fn() };
    await controller.updateState(req, 3, {
      positionSeconds: 1,
      durationSeconds: 60,
      mediaFileId: 9,
      sessionId: 's',
      qoe,
    });
    return recordSample.mock.calls[0]?.[1].variantBitrate;
  }
  const live = { userId: 7, attributedUserId: null, kind: 'transcode', quality: '1080p', hdrLadder: false, sseConnectionId: null, bitrateByQuality: { '1080p': { videoBitrateBps: 8_000_000, audioBitrateBps: 192_000, totalBitrateBps: 8_192_000 } } };

  it('fills the bitrate from the served transcode rung', async () => {
    expect(await beat(live)).toBe(8_000_000);
  });

  it('keeps the client value, and stays null for remux', async () => {
    expect(await beat(live, { ...sample, variantBitrate: 3e6 })).toBe(3e6);
    expect(await beat({ ...live, kind: 'remux' })).toBeNull();
  });

  it('stays null for a non-string quality instead of throwing', async () => {
    expect(await beat({ ...live, hdrLadder: true, quality: 1080 })).toBeNull();
  });

  it('records nothing for a session that is not the caller\'s', async () => {
    expect(await beat({ ...live, userId: 8 })).toBeUndefined();
    expect(await beat({ ...live, userId: 8, attributedUserId: 7 })).toBe(8_000_000);
  });
});

describe('PlaybackController.updateState: engine runtime', () => {
  const tick = (over: Record<string, unknown> = {}) => ({
    positionSeconds: 120,
    durationSeconds: 6000,
    mediaFileId: 9,
    sessionId: 'sid-1',
    state: 'playing' as const,
    quality: '720p',
    ...over,
  });
  const snap = {
    sessionId: 'sid-1',
    ownerId: '7',
    mediaFileId: 9,
    profileHash: 'h',
    kind: 'transcode',
    quality: '720p',
    client: {},
    tags: { sseConnectionId: 'conn-1', mediaTitle: 'Dune' },
    openedAtMs: 1,
    lastBeatMs: 2,
    positionS: 0,
    state: 'playing',
    pinned: false,
    decision: JSON.parse(readFileSync(join(__dirname, '../streaming/services/engine-playback.recorded.json'), 'utf8')).engine.decision,
  };

  function build(engine: Record<string, unknown>, present: { userId?: number; attributedUserId?: number } | null = { userId: 7 }) {
    const { controller, emitToUser } = buildController();
    const liveSessions = new LiveSessionRegistry();
    if (present) liveSessions.create({ sessionId: 'sid-1', username: null, mediaFileId: 9, kind: 'transcode', sseConnectionId: 'conn-1', userId: 7, ...present });
    const wired = controller as unknown as Record<string, unknown>;
    wired.liveSessions = liveSessions;
    wired.engine = { runtime: true, heartbeat: jest.fn().mockResolvedValue({ sessionLost: false }), getSession: jest.fn().mockResolvedValue(snap), ...engine };
    (wired.events as { targetIdFor: () => string }).targetIdFor = () => 'target-1';
    return { controller, emitToUser, liveSessions, engine: wired.engine as Record<string, jest.Mock> };
  }

  it('beats the engine as the owner, and keeps the app-side heartbeat and remote.state', async () => {
    const { controller, emitToUser, liveSessions, engine } = build({});
    const res = await controller.updateState(req, 3, tick());
    expect(engine.heartbeat).toHaveBeenCalledWith('sid-1', { ownerId: '7', positionS: 120, state: 'playing', quality: '720p' });
    expect(liveSessions.peek('sid-1')).toMatchObject({ position: 120, quality: '720p' });
    expect(emitToUser).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'remote.state', sessionId: 'sid-1' }));
    expect(res).toMatchObject({ state: { id: 1 } });
    expect((res as { sessionLost?: boolean }).sessionLost).toBeUndefined();
  });

  it('answers sessionLost when the engine lost the session, and does not fan out', async () => {
    const { controller, emitToUser } = build({ heartbeat: jest.fn().mockResolvedValue({ sessionLost: true }) });
    expect(await controller.updateState(req, 3, tick())).toMatchObject({ sessionLost: true });
    expect(emitToUser).not.toHaveBeenCalled();
  });

  it('refuses another user\'s session before asking the engine', async () => {
    const { controller, engine } = build({}, { userId: 9 });
    await expect(controller.updateState(req, 3, tick())).rejects.toThrow(ForbiddenException);
    expect(engine.heartbeat).not.toHaveBeenCalled();
  });

  it('lets the attributed user beat, as the engine\'s owner of the session', async () => {
    const { controller, engine } = build({}, { userId: 9, attributedUserId: 7 });
    await controller.updateState(req, 3, tick());
    expect(engine.heartbeat.mock.calls[0][1].ownerId).toBe('9');
  });

  it('maps the engine\'s 403 (no presence to check against) to a refusal', async () => {
    const { controller } = build({ heartbeat: jest.fn().mockRejectedValue(new EngineError(403, 'x')) }, null);
    await expect(controller.updateState(req, 3, tick())).rejects.toThrow(ForbiddenException);
  });

  it('rebuilds the presence of a session the engine revived', async () => {
    const { controller, liveSessions, emitToUser } = build({}, null);
    await controller.updateState(req, 3, tick());
    expect(liveSessions.peek('sid-1')).toMatchObject({ userId: 7, mediaTitle: 'Dune', position: 120 });
    expect(emitToUser).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'remote.state', mediaTitle: 'Dune' }));
  });

  it('falls back to the registry when the engine cannot be asked', async () => {
    const { controller, liveSessions } = build({ heartbeat: jest.fn().mockRejectedValue(new TypeError('fetch failed')) });
    const res = await controller.updateState(req, 3, tick());
    expect(liveSessions.peek('sid-1')!.position).toBe(120);
    expect((res as { sessionLost?: boolean }).sessionLost).toBeUndefined();
  });
});
