import { describe, expect, it, vi } from 'vitest';
import { CastPlayerService } from './cast-player.service';

const sample = { engine: 'cast', stallCount: 1, recoveryReloads: 0, bandwidthBps: 9 };
const qoeSample = (
  receivedAt: number | null,
  playbackId: string | null = null,
  recoveries = 0,
  s: object = sample,
  sid?: string,
) =>
  CastPlayerService.prototype.qoeSample.call({
    playbackId,
    recoveries,
    liveSessionId: () => 'live',
    cast: { receiverQoe: () => (receivedAt === null ? null : { sample: s, receivedAt, sid }) },
  } as never);

describe('CastPlayerService.qoeSample', () => {
  it('returns the receiver sample while it is fresh', () => {
    expect(qoeSample(Date.now())).toMatchObject(sample);
  });

  it('stamps the playbackId of the viewing that was cast', () => {
    expect(qoeSample(Date.now(), 'pb-1')).toMatchObject({ ...sample, playbackId: 'pb-1' });
  });

  it('keeps the id the receiver echoed and adds the sender-side recoveries', () => {
    expect(qoeSample(Date.now(), 'pb-1', 1, { ...sample, playbackId: 'rx' })).toMatchObject({
      playbackId: 'rx',
      recoveryReloads: 1,
    });
  });

  it('does not forward the stall episodes in the heartbeat', () => {
    const s = { ...sample, stalls: [{ at: 1, durationMs: 2 }] };
    expect(qoeSample(Date.now(), null, 0, s)).not.toHaveProperty('stalls');
  });

  it('sends nothing while the receiver measured nothing', () => {
    expect(qoeSample(Date.now(), null, 0, { engine: 'cast', recoveryReloads: 0, bandwidthBps: null })).toBeNull();
  });

  it('drops a sample echoed from another load, keeps one from the current load', () => {
    expect(qoeSample(Date.now(), null, 0, sample, 'old')).toBeNull();
    expect(qoeSample(Date.now(), null, 0, sample, 'live')).toMatchObject(sample);
  });

  it('drops a stale sample and an absent one', () => {
    expect(qoeSample(Date.now() - 60_000)).toBeNull();
    expect(qoeSample(null)).toBeNull();
  });
});

describe('CastPlayerService.recordReceiverStalls', () => {
  const ep = { at: 1000, position: 12, durationMs: 2000, bufferAheadS: 0.2, bandwidthBps: 5, variantBitrate: 4e6 };

  it('turns each episode into one stall event, even when the message repeats', () => {
    const record = vi.fn();
    const self = { liveSessionId: () => 's', seenStalls: new Set<number>(), qoeReporter: { record }, playbackId: 'pb' };
    const call = (q: object) => (CastPlayerService.prototype as any).recordReceiverStalls.call(self, q);
    call({ sample: { stalls: [ep] } });
    call({ sample: { stalls: [ep, { ...ep, at: 9000 }] } });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      's',
      { type: 'stall', at: 3000, position: 12, durationMs: 2000, bufferAheadS: 0.2, bandwidthBps: 5, variantBitrate: 4e6 },
      false,
      'pb',
    );
  });

  it('drops the episodes of a previous load after a reload', () => {
    const record = vi.fn();
    const self = { liveSessionId: () => 's2', seenStalls: new Set<number>(), qoeReporter: { record }, playbackId: 'pb' };
    (CastPlayerService.prototype as any).recordReceiverStalls.call(self, { sid: 's1', sample: { stalls: [ep] } });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('CastPlayerService reporting without the player page', () => {
  const proto = CastPlayerService.prototype as any;

  function saver(response: object) {
    const qoeReporter = { flush: vi.fn(), record: vi.fn() };
    const self = {
      mediaFileId: () => 1,
      mediaId: () => 2,
      episodeId: () => undefined,
      liveSessionId: () => 's',
      qoeSample: () => null,
      cast: { currentTime: () => 30, duration: () => 100, isPaused: () => false, saveHeartbeat: vi.fn() },
      authService: { accessToken: 'tok', ensureStreamToken: vi.fn(async () => 'st') },
      serverConfig: { resolveUrl: (p: string) => p },
      streamingApi: { updatePlaybackState: vi.fn(async () => response) },
      reloadCastStream: vi.fn(async () => {}),
      recordRecovery: proto.recordRecovery,
      recoveries: 0,
      playbackId: 'pb',
      qoeReporter,
    };
    return { self, qoeReporter };
  }

  it('flushes the cast session events after each heartbeat', async () => {
    const { self, qoeReporter } = saver({});
    await proto.saveCastPosition.call(self);
    expect(qoeReporter.flush).toHaveBeenCalledWith('s');
  });

  it('hands the native side the heartbeat to repeat while the phone is locked', async () => {
    const { self } = saver({});
    await proto.saveCastPosition.call(self);
    expect(self.cast.saveHeartbeat).toHaveBeenCalledWith({
      url: '/api/playback/media/2/state',
      token: 'st',
      body: expect.objectContaining({ positionSeconds: 30, mediaFileId: 1, sessionId: 's' }),
    });
  });

  it('records a session_lost recovery when the heartbeat reloads the stream', async () => {
    const { self, qoeReporter } = saver({ sessionLost: true });
    await proto.saveCastPosition.call(self);
    expect(self.reloadCastStream).toHaveBeenCalledWith(30, true);
    expect(qoeReporter.record).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ type: 'recovery', position: 30, reason: 'session_lost' }),
      false,
      'pb',
    );
  });

  it('sends the pending events with keepalive before the cast stops', () => {
    const order: string[] = [];
    const self = {
      disconnectGrace: null,
      liveSessionId: () => 's',
      saveCastPosition: vi.fn(),
      stopPositionSaving: vi.fn(),
      qoeReporter: { flushKeepalive: vi.fn(() => order.push('keepalive')) },
      streamingApi: { stopSession: vi.fn(() => (order.push('stop'), Promise.resolve())) },
      setLiveSession: vi.fn(),
      hasMedia: { set: vi.fn() },
      expanded: { set: vi.fn() },
      mediaFileId: { set: vi.fn() },
      spriteUrl: { set: vi.fn() },
      spriteMetadata: { set: vi.fn() },
    };
    proto.clear.call(self);
    expect(self.qoeReporter.flushKeepalive).toHaveBeenCalledWith('s');
    expect(order).toEqual(['keepalive', 'stop']);
  });
});
