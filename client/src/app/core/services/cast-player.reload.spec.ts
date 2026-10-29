import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { CastPlayerService } from './cast-player.service';

type Info = { sessionId: string; qualities: never[] };

function harness(infos: Promise<Info>[]) {
  const svc = Object.create(CastPlayerService.prototype) as Record<string, unknown>;
  let live = 'old';
  const order: string[] = [];
  const next = [...infos];
  Object.assign(svc, {
    reloadGen: 0,
    reloading: signal(false),
    mediaFileId: () => 1,
    liveSessionId: () => live,
    activeAudioStreamIndex: () => undefined,
    activeQualityId: () => '1080p',
    activeBurnInId: null,
    cast: { currentTime: () => 10 },
    getCastPlaybackInfo: vi.fn(() => next.shift()),
    authService: { getCastInfo: async () => ({ token: 't', streamBaseUrl: 'b' }) },
    streamingApi: { stopSession: vi.fn(async (sid: string) => void order.push(`stop:${sid}`)) },
    dispatchLoad: vi.fn(async (_m: number, pi: Info) => {
      live = pi.sessionId;
      order.push(`load:${pi.sessionId}`);
      return true;
    }),
  });
  return { svc: svc as unknown as CastPlayerService, order };
}

describe('cast reload single-flight', () => {
  it('stops the old session only after the new LOAD resolves', async () => {
    const { svc, order } = harness([Promise.resolve({ sessionId: 'n', qualities: [] })]);
    await svc.reloadCastStream();
    expect(order).toEqual(['load:n', 'stop:old']);
  });

  it('lets only the latest overlapping reload LOAD and drops the superseded session', async () => {
    let release!: (i: Info) => void;
    const slow = new Promise<Info>((r) => (release = r));
    const { svc, order } = harness([slow, Promise.resolve({ sessionId: 'b', qualities: [] })]);
    const first = svc.reloadCastStream();
    await svc.reloadCastStream();
    release({ sessionId: 'a', qualities: [] });
    await first;
    expect(order).toEqual(['load:b', 'stop:old', 'stop:a']);
    expect(svc.reloading()).toBe(false);
  });

  it('skips the heartbeat recovery while a reload runs', async () => {
    const reloadCastStream = vi.fn();
    const self = {
      mediaFileId: () => 1, mediaId: () => 2, episodeId: () => undefined, liveSessionId: () => 's',
      qoeSample: () => null, cast: { receiverPlays: () => true, currentTime: () => 30, duration: () => 100, isPaused: () => false },
      streamingApi: { updatePlaybackState: vi.fn(async () => ({ sessionLost: true })) },
      qoeReporter: { flush: vi.fn() }, reloading: signal(true), reloadCastStream,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (CastPlayerService.prototype as any).saveCastPosition.call(self);
    expect(reloadCastStream).not.toHaveBeenCalled();
  });
});
