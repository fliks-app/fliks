import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { CastPlayerService } from './cast-player.service';
import { LatestWins } from '../utils/latest-wins';

type Info = { sessionId: string; qualities: never[] };

function harness(infos: Promise<Info>[]) {
  const svc = Object.create(CastPlayerService.prototype) as Record<string, unknown>;
  let live = 'old';
  const order: string[] = [];
  const next = [...infos];
  Object.assign(svc, {
    reloads: new LatestWins(),
    reloading: signal(false),
    failed: signal(false),
    mediaFileId: () => 1,
    liveSessionId: () => live,
    activeAudioStreamIndex: () => undefined,
    activeQualityId: () => '1080p',
    activeBurnInId: null,
    cast: { currentTime: () => 10 },
    getCastPlaybackInfo: vi.fn(() => next.shift()),
    authService: { getCastInfo: async () => ({ token: 't', streamBaseUrl: 'b' }) },
    streamingApi: {
      stopSession: vi.fn(async (sid: string) => void order.push(`stop:${sid}`)),
      retireSession: vi.fn(async (sid?: string) => ({ replaces: sid })),
    },
    dispatchLoad: vi.fn(async (_m: number, pi: Info) => {
      live = pi.sessionId;
      order.push(`load:${pi.sessionId}`);
      return true;
    }),
  });
  return { svc: svc as unknown as CastPlayerService, order, info: svc['getCastPlaybackInfo'] as ReturnType<typeof vi.fn> };
}

describe('cast reload single-flight', () => {
  it('opens the new session as the replacement of the old one, which is never stopped separately', async () => {
    const { svc, order, info } = harness([Promise.resolve({ sessionId: 'n', qualities: [] })]);
    await svc.reloadCastStream();
    expect(info.mock.calls[0][5]).toBe('old');
    expect(order).toEqual(['load:n']);
  });

  it('lets only the latest overlapping reload LOAD and drops the superseded session', async () => {
    let release!: (i: Info) => void;
    const slow = new Promise<Info>((r) => (release = r));
    const { svc, order } = harness([slow, Promise.resolve({ sessionId: 'b', qualities: [] })]);
    const first = svc.reloadCastStream();
    await svc.reloadCastStream();
    release({ sessionId: 'a', qualities: [] });
    await first;
    expect(order).toEqual(['load:b', 'stop:a']);
    expect(svc.reloading()).toBe(false);
  });

  it('skips the heartbeat recovery while a reload runs', async () => {
    const reloadCastStream = vi.fn();
    const self = { reloading: signal(true), reloadCastStream };
    await CastPlayerService.prototype.recoverLostSession.call(self as never, 30);
    expect(reloadCastStream).not.toHaveBeenCalled();
  });

  it('reloads on a stream.reload of its own session while connected', () => {
    const reloadCastStream = vi.fn();
    const call = (sid: unknown, connected: boolean) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (CastPlayerService.prototype as any).onStreamReload.call(
        { liveSessionId: () => 's', cast: { isConnected: () => connected }, reloadCastStream },
        sid,
      );
    call('other', true);
    call('s', false);
    expect(reloadCastStream).not.toHaveBeenCalled();
    call('s', true);
    expect(reloadCastStream).toHaveBeenCalledTimes(1);
  });
});
