import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { PlayerStateService } from '../../../core/services/player-state.service';
import { LivePlayerComponent } from './live-player';
import { LiveTvApiService, PlaySession } from '../../../core/services/api/livetv-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { ServerVersionService } from '../../../core/services/server-version.service';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { ToastService } from '../../../core/services/toast.service';
import { SessionSyncService } from '../../../core/services/session-sync.service';
import { ControlsVisibilityService } from '../../player/controls/controls-visibility';

function makeSession(id: string, channelId: number): PlaySession {
  return {
    sessionId: id,
    channelId,
    channelName: `Channel ${channelId}`,
    url: `/live/${channelId}.m3u8`,
    mode: 'remux',
    isLive: true,
    dvrWindowSeconds: 0,
    segmentSeconds: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * `TestBed.createComponent` would also instantiate the real controls/overlay
 * children declared in the template, pulling in their whole DI graph for a
 * test that only exercises the component's own bookkeeping.
 */
function createComponent(overrides: Record<string, unknown> = {}) {
  const stopCalls: string[] = [];
  const plays = new Map<number, ReturnType<typeof deferred<PlaySession>>>();
  const api = {
    play: vi.fn((channelId: number) => {
      const d = deferred<PlaySession>();
      plays.set(channelId, d);
      return d.promise;
    }),
    stopSession: vi.fn((id: string) => {
      stopCalls.push(id);
      return Promise.resolve();
    }),
    getChannels: vi.fn().mockResolvedValue([]),
    getOnNow: vi.fn().mockResolvedValue({ entries: [], page: 1, pageSize: 50, total: 0 }),
    ...overrides,
  };
  const router = { navigate: vi.fn() };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => '5' } },
          paramMap: { subscribe: () => ({ unsubscribe() {} }) },
        },
      },
      { provide: Router, useValue: router },
      { provide: ServerVersionService, useValue: { requestAdds: () => true, supports: () => true, supportsWhenKnown: async () => true } },
      { provide: LiveTvApiService, useValue: api },
      {
        provide: DeviceService,
        useValue: {
          tvPlatform: () => null,
          desktopPlatform: () => null,
          isTv: () => false,
          reducedEffects: () => false,
          isDesktop: () => false,
        },
      },
      {
        provide: ServerConfigService,
        useValue: { isNative: false, resolveUrl: (p: string) => p },
      },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (key: string) => key, currentLang: () => 'en' } },
      { provide: SessionSyncService, useValue: { registerPlayer: () => () => {} } },
      ControlsVisibilityService,
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component = TestBed.runInInjectionContext(() => new LivePlayerComponent()) as any;
  component.loadIntoEngine = vi.fn().mockResolvedValue(undefined);
  return { component, api, router, stopCalls, plays };
}

describe('LivePlayerComponent — concurrent tune()', () => {
  it('a second zap fired mid-switch wins, and only its session survives', async () => {
    const { component, api, router, stopCalls, plays } = createComponent();
    // Already watching channel 5 — the outgoing session both zaps must release.
    component.currentSessionId = 's5';
    component.session.set(makeSession('s5', 5));

    const first = component.tune(10);
    const second = component.tune(20);

    await Promise.resolve();
    await Promise.resolve();
    // The later zap resolves first — the earlier one must not overwrite it.
    plays.get(20)!.resolve(makeSession('s20', 20));
    await Promise.resolve();
    plays.get(10)?.resolve(makeSession('s10', 10));

    await Promise.all([first, second]);

    expect(api.play).toHaveBeenCalledTimes(1);
    expect(api.play).toHaveBeenCalledWith(20, expect.anything());
    expect(component.session().sessionId).toBe('s20');
    expect(stopCalls).toContain('s5');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('an earlier zap whose play() resolves after losing stops its own late session', async () => {
    const { component, api, stopCalls, plays } = createComponent();
    component.currentSessionId = 's5';
    component.session.set(makeSession('s5', 5));

    const first = component.tune(10);
    await flush();
    expect(api.play).toHaveBeenCalledWith(10, expect.anything());

    const second = component.tune(20);
    await flush();

    // The loser's play() only resolves once it has already been superseded.
    plays.get(10)!.resolve(makeSession('s10', 10));
    await flush();
    plays.get(20)!.resolve(makeSession('s20', 20));

    await Promise.all([first, second]);

    expect(stopCalls).toEqual(['s5', 's10']);
    expect(component.loadIntoEngine).toHaveBeenCalledTimes(1);
    expect(component.loadIntoEngine).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's20' }),
    );
    expect(component.session()?.sessionId).toBe('s20');
  });

  it('destroying mid-tune releases the late session instead of loading it', async () => {
    const { component, stopCalls, plays } = createComponent();
    component.currentSessionId = 's5';
    component.session.set(makeSession('s5', 5));

    const tunePromise = component.tune(30);
    await flush();
    // Outgoing session already released; api.play(30) is now in flight.

    component.ngOnDestroy();
    plays.get(30)!.resolve(makeSession('s30', 30));
    await tunePromise;

    expect(stopCalls).toEqual(['s5', 's30']);
    expect(component.loadIntoEngine).not.toHaveBeenCalled();
    expect(component.session()).toBeNull();
  });
});

describe('LivePlayerComponent — handlePlayError', () => {
  it('sends the viewer back on a 404 or 403', () => {
    const { component, router } = createComponent();

    component.handlePlayError(new HttpErrorResponse({ status: 404 }));

    expect(router.navigate).toHaveBeenCalledWith(['/live-tv'], { state: { rootEntry: true } });
    expect(component.playbackError()).toBeNull();
  });

  it('surfaces a 409 on the retry overlay without navigating away', () => {
    const { component, router } = createComponent();

    component.handlePlayError(
      new HttpErrorResponse({
        status: 409,
        error: { code: 'livetv_source_at_capacity', sourceName: 'Source', limit: 2 },
      }),
    );

    expect(component.playbackError()).not.toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('surfaces the per-user viewer cap 409 on the retry overlay without navigating away', () => {
    const { component, router } = createComponent();

    component.handlePlayError(
      new HttpErrorResponse({ status: 409, error: { code: 'livetv_user_at_capacity', limit: 1 } }),
    );

    expect(component.playbackError()?.userMessage).toContain('error_user_at_capacity');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('surfaces an expired-account 503 on the retry overlay without navigating away', () => {
    const { component, router } = createComponent();

    component.handlePlayError(
      new HttpErrorResponse({
        status: 503,
        error: { code: 'livetv_account_expired', channelName: 'Channel 1', sourceName: 'Source' },
      }),
    );

    expect(component.playbackError()).not.toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe('LivePlayerComponent — sessionExpired', () => {
  it('re-tunes the current channel through the recovery controller', async () => {
    const { component, api, stopCalls, plays } = createComponent();
    component.engine = { currentTime: 0 };
    component.currentSessionId = 's5';
    component.session.set(makeSession('s5', 5));
    component.currentChannelId.set(5);
    component.loading.set(false);

    void component.recovery.recoverFromLostSession('session_expired');
    await flush(8);
    plays.get(5)!.resolve(makeSession('s5b', 5));
    await flush(8);

    expect(stopCalls).toEqual(['s5']);
    expect(api.play).toHaveBeenCalledWith(5, expect.anything());
    expect(component.session().sessionId).toBe('s5b');
  });

  it('stands aside while a user zap is in flight', async () => {
    const { component, api } = createComponent();
    component.engine = { currentTime: 0 };
    component.currentSessionId = 's5';
    component.zaps = 1;

    await component.recovery.recoverFromLostSession('session_expired');

    expect(api.play).not.toHaveBeenCalled();
  });

  it('throws from the re-tune when the session cannot be minted, so the controller backs off', async () => {
    const { component } = createComponent({ play: vi.fn().mockRejectedValue(new Error('down')) });
    component.currentChannelId.set(5);

    await expect(component.retune()).rejects.toThrow('down');
  });
});

describe('LivePlayerComponent volume', () => {
  it('shares the level with the video player and pushes it on engine creation', async () => {
    const { component } = createComponent();
    const state = TestBed.inject(PlayerStateService);
    const handlers: Record<string, (e: unknown) => void> = {};
    const engine = { volume: 1, on: (n: string, h: (e: unknown) => void) => (handlers[n] = h) };
    state.volume.set(0.4);
    expect(component.volume()).toBe(0.4);

    component.bindEngine(engine);
    expect(engine.volume).toBe(0.4);

    handlers['volumechange']({ volume: 0.7, muted: true });
    expect(state.volume()).toBe(0.7);
    expect(component.muted()).toBe(true);
  });
});

describe('LivePlayerComponent zap list', () => {
  const lineup = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, number: i + 1 }));

  it('is built from one channels call, in server order', async () => {
    const list = lineup(3);
    const { component, api, router } = createComponent({ getChannels: vi.fn().mockResolvedValue(list) });
    component.currentChannelId.set(3);

    await component.loadChannels();
    component.channelUp();

    expect(api.getChannels).toHaveBeenCalledTimes(1);
    expect(api.getOnNow).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/watch-live', 1]);
  });

  it('fetches now/next only for the pages of the rendered window', async () => {
    const { component, api } = createComponent();
    const list = lineup(120);
    api.getOnNow.mockImplementation(async ({ page }: { page: number }) => ({
      entries: list.slice((page - 1) * 50, page * 50).map((channel) => ({ channel, now: null, next: null })),
      page,
      pageSize: 50,
      total: 120,
    }));
    component.channels.set(list);
    component.miniGuideOpen.set(true);
    TestBed.tick();
    await flush(8);
    expect(api.getOnNow.mock.calls.map((c: unknown[]) => (c[0] as { page: number }).page)).toEqual([1]);

    component.windowFirst.set(40);
    TestBed.tick();
    await flush(8);
    expect(api.getOnNow.mock.calls.map((c: unknown[]) => (c[0] as { page: number }).page)).toEqual([1, 2]);
  });
});

describe('LivePlayerComponent TV hide and show', () => {
  function flip(component: { onTvVisibility: () => void }, state: DocumentVisibilityState) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    component.onTvVisibility();
  }

  it('releases the viewer session on hide and re-tunes on show', async () => {
    const { component, api, plays } = createComponent();
    const pause = vi.fn();
    component.engine = { pause };
    component.api.stopSessionOnUnload = vi.fn();
    component.liveQoe.end = vi.fn();
    component.currentSessionId = 's5';
    component.session.set(makeSession('s5', 5));
    component.currentChannelId.set(5);

    flip(component, 'hidden');
    expect(pause).toHaveBeenCalledOnce();
    expect(component.api.stopSessionOnUnload).toHaveBeenCalledWith('s5');
    expect(component.currentSessionId).toBeNull();
    expect(component.session()).toBeNull();

    flip(component, 'visible');
    await flush();
    plays.get(5)!.resolve(makeSession('s5b', 5));
    await flush();
    expect(api.play).toHaveBeenCalledWith(5, expect.anything());
    expect(component.session().sessionId).toBe('s5b');
    vi.restoreAllMocks();
  });
});
