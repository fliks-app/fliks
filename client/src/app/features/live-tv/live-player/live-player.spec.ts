import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { LivePlayerComponent } from './live-player';
import { LiveTvApiService, PlaySession } from '../../../core/services/api/livetv-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { ToastService } from '../../../core/services/toast.service';
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
function createComponent() {
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
      { provide: LiveTvApiService, useValue: api },
      {
        provide: DeviceService,
        useValue: {
          tvPlatform: () => null,
          desktopPlatform: () => null,
          isTv: () => false,
          isDesktop: () => false,
        },
      },
      {
        provide: ServerConfigService,
        useValue: { isNative: false, resolveUrl: (p: string) => p },
      },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
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
});
