import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { RemoteService, type RemoteTarget } from './remote.service';
import { SseService, type RemoteCommand, type RemoteState } from './sse.service';
import { ToastService } from './toast.service';

function frame(over: Partial<RemoteState> = {}): RemoteState {
  return {
    type: 'remote.state',
    targetId: 'tv#1',
    sessionId: 'sid-1',
    mediaId: 1,
    mediaFileId: 2,
    mediaTitle: 'A series',
    episodeLabel: 'S1:E2 - An episode',
    posterUrl: null,
    positionSeconds: 30,
    durationSeconds: 100,
    state: 'playing',
    volume: 0.5,
    muted: false,
    supportsVolume: true,
    subtitleId: null,
    quality: '1080p',
    qualities: null,
    autoplayBlocked: false,
    hasNext: false,
    audioTrackIndex: 0,
    subtitleTrackIndex: null,
    lastCmdId: null,
    ...over,
  };
}

function setup() {
  const remoteState = signal<RemoteState | null>(null);
  const sse = {
    commands: new Subject<RemoteCommand>(),
    stopped: new Subject<string>(),
    remoteState,
    lastEvent: signal(null),
    connectionId: signal<string | null>(null),
    targetId: signal<string | null>('phone#1'),
  };
  TestBed.configureTestingModule({
    providers: [
      RemoteService,
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SseService, useValue: sse },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), info: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const service = TestBed.inject(RemoteService);
  service.selectedTargetId.set('tv#1');
  return { service, remoteState, sse };
}

/**
 * The target flushes one last heartbeat on its way out of the player, so a stop
 * that only cleared local state put the stopped playback straight back on
 * screen and left it there, since nothing follows it.
 */
describe('RemoteService stop handling', () => {
  it('takes a state frame while the target is playing', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame());
    service.ingestState();
    expect(service.targetState()?.mediaTitle).toBe('A series');
  });

  it('ignores a frame that trails a stop', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame());
    service.ingestState();

    service.noteStopSent();
    remoteState.set(frame({ positionSeconds: 31 }));
    service.ingestState();

    expect(service.targetState()).toBeNull();
  });

  it('clears on a stop the server announced', () => {
    const { service, remoteState, sse } = setup();
    remoteState.set(frame());
    service.ingestState();
    expect(service.targetState()).not.toBeNull();

    // Read from a subject, not the shared last-value signal: the server emits
    // `remote.targets_changed` immediately after, which replaced the stop
    // before any effect had run.
    sse.stopped.next('tv#1');

    expect(service.targetState()).toBeNull();
  });

  it('keeps the card while a quality change rebuilds the stream', () => {
    const { service, remoteState, sse } = setup();
    remoteState.set(frame());
    service.ingestState();

    // Same title at the same place: the stop is the old session leaving, so the
    // poster, title and position stay and the card only reads as loading.
    service.pendingAction.set('quality');
    sse.stopped.next('tv#1');

    expect(service.targetState()?.mediaTitle).toBe('A series');
    expect(service.restarting()).toBe(true);
  });

  it('takes the next session right away when the target switches episode', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame({ sessionId: 'sid-1' }));
    service.ingestState();

    // The target retires one session and starts another within the same second,
    // so only the dead session's own farewell may be ignored.
    service.noteStopSent();
    remoteState.set(frame({ sessionId: 'sid-2', mediaFileId: 3, positionSeconds: 0 }));
    service.ingestState();

    expect(service.targetState()?.sessionId).toBe('sid-2');
  });

  it('holds a requested seek position until the target reports it', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame({ positionSeconds: 30 }));
    service.ingestState();

    // The cue that triggers a skip is computed from this position, so it has to
    // move on the gesture rather than when the coalesced POST goes out.
    service.sendCoalesced('tv#1', { action: 'seek', positionSeconds: 90 });
    expect(service.interpolatedPosition()).toBeGreaterThanOrEqual(90);

    remoteState.set(frame({ positionSeconds: 91 }));
    service.ingestState();
    expect(service.interpolatedPosition()).toBeGreaterThanOrEqual(91);
  });

  it('advances the position between reports, and holds it when paused', () => {
    vi.useFakeTimers();
    try {
      const { service, remoteState } = setup();
      remoteState.set(frame({ positionSeconds: 30, state: 'playing' }));
      service.ingestState();
      expect(service.interpolatedPosition()).toBeCloseTo(30, 1);

      vi.advanceTimersByTime(4_000);
      expect(service.interpolatedPosition()).toBeCloseTo(34, 1);

      // A report resynchronises rather than adding to the estimate.
      remoteState.set(frame({ positionSeconds: 40, state: 'playing' }));
      service.ingestState();
      expect(service.interpolatedPosition()).toBeCloseTo(40, 1);

      remoteState.set(frame({ positionSeconds: 40, state: 'paused' }));
      service.ingestState();
      vi.advanceTimersByTime(4_000);
      expect(service.interpolatedPosition()).toBeCloseTo(40, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops ticking once a silent target leaves the grace window', () => {
    vi.useFakeTimers();
    try {
      const { service } = setup();
      TestBed.tick();
      expect(service.awaitingFirstReport()).toBe(true);
      const ticking = vi.getTimerCount();

      vi.advanceTimersByTime(13_000);

      expect(service.awaitingFirstReport()).toBe(false);
      expect(vi.getTimerCount()).toBe(ticking - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the previous title when a new load is sent', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame({ mediaFileId: 2 }));
    service.ingestState();
    expect(service.targetState()).not.toBeNull();

    service.noteLoadSent(9);
    expect(service.targetState()).toBeNull();

    // The outgoing session flushes one last heartbeat for the old file.
    remoteState.set(frame({ mediaFileId: 2, positionSeconds: 31 }));
    service.ingestState();
    expect(service.targetState()).toBeNull();

    remoteState.set(frame({ mediaFileId: 9, mediaTitle: 'Another', positionSeconds: 0 }));
    service.ingestState();
    expect(service.targetState()?.mediaTitle).toBe('Another');
  });

  it('drops the reading when the target says it stopped playing', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame());
    service.ingestState();
    expect(service.targetState()).not.toBeNull();

    service.noteTargetStopped('tv#1');
    expect(service.targetState()).toBeNull();

    // The player flushes one last heartbeat on its way out.
    remoteState.set(frame({ positionSeconds: 31 }));
    service.ingestState();
    expect(service.targetState()).toBeNull();
  });

  it('ignores a stop announced for another target', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame());
    service.ingestState();

    service.noteTargetStopped('other#9');

    expect(service.targetState()).not.toBeNull();
  });

  it('pins the volume the user set until the target agrees', () => {
    const { service, remoteState } = setup();
    remoteState.set(frame({ volume: 0.5 }));
    service.ingestState();

    service.pinVolume(0.9);
    // A seek reliably provokes a frame still carrying the old level.
    remoteState.set(frame({ volume: 0.5, positionSeconds: 60 }));
    service.ingestState();
    expect(service.targetState()?.volume).toBe(0.9);

    remoteState.set(frame({ volume: 0.9, positionSeconds: 61 }));
    service.ingestState();
    expect(service.targetState()?.volume).toBe(0.9);
  });
});

describe('RemoteService applyLoad', () => {
  it('puts t=0 on the load url when the position is exactly zero', async () => {
    const { service } = setup();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const sse = TestBed.inject(SseService);

    sse.commands.next({
      type: 'remote.command',
      cmdId: 'cmd-load',
      expiresAt: Date.now() + 10_000,
      byTargetId: null,
      action: 'load',
      mediaFileId: 42,
      positionSeconds: 0,
    });

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(navigateSpy).toHaveBeenCalledWith(['/watch', 42], { queryParams: { t: 0 } });
  });
});

describe('RemoteService browse', () => {
  function browseCmd(over: Partial<RemoteCommand> = {}): RemoteCommand {
    return {
      type: 'remote.command',
      cmdId: 'cmd-browse',
      expiresAt: Date.now() + 10_000,
      byTargetId: null,
      action: 'browse',
      mediaId: 7,
      mediaType: 'series',
      episodeId: 12,
      ...over,
    };
  }

  it('opens the browsed detail page on the target', async () => {
    const { service } = setup();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    TestBed.inject(SseService).commands.next(browseCmd());

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(navigateSpy).toHaveBeenCalledWith(['/series', 7, 'episode', 12]);
    expect(service.pendingAction()).toBeNull();
  });

  it('never leaves a playing player for a browse', async () => {
    setup();
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/watch/3');
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    TestBed.inject(SseService).commands.next(browseCmd({ mediaType: 'movie', episodeId: undefined }));

    await Promise.resolve();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not mirror a browse it just applied back to its own target', async () => {
    const { service } = setup();
    const http = TestBed.inject(HttpTestingController);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    TestBed.inject(SseService).commands.next(browseCmd());
    await Promise.resolve();
    service.browse({ mediaId: 7, mediaType: 'series', episodeId: 12 });
    http.expectNone('/api/remote/tv%231/command');

    service.browse({ mediaId: 8, mediaType: 'movie' });
    const req = http.expectOne('/api/remote/tv%231/command');
    expect(req.request.body).toMatchObject({ action: 'browse', mediaId: 8, mediaType: 'movie' });
    expect(service.pendingAction()).toBeNull();
  });
});

describe('RemoteService recovers from an unlanded load', () => {
  it('accepts a later frame for another file once an unacked load times out', async () => {
    vi.useFakeTimers();
    try {
      const { service, remoteState } = setup();
      const httpMock = TestBed.inject(HttpTestingController);

      const sendPromise = service.send('tv#1', { action: 'load', mediaFileId: 9 });
      httpMock.expectOne('/api/remote/tv%231/command').flush({ cmdId: 'cmd-1' });
      await sendPromise;

      // Nothing has landed for file 9 yet, so a stale report is ignored.
      remoteState.set(frame({ mediaFileId: 2, positionSeconds: 5 }));
      service.ingestState();
      expect(service.targetState()).toBeNull();

      vi.advanceTimersByTime(20_000);

      remoteState.set(frame({ mediaFileId: 2, mediaTitle: 'Something else' }));
      service.ingestState();
      expect(service.targetState()?.mediaTitle).toBe('Something else');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a later frame after selecting another target mid-load', () => {
    const { service, remoteState } = setup();
    service.noteLoadSent(9);
    expect(service.targetState()).toBeNull();

    service.selectTarget('tv#2');

    remoteState.set(frame({ targetId: 'tv#2', mediaFileId: 2, mediaTitle: 'Elsewhere' }));
    service.ingestState();
    expect(service.targetState()?.mediaTitle).toBe('Elsewhere');
  });
});

describe('RemoteService refreshTargets', () => {
  const target: RemoteTarget = {
    targetId: 'tv#1',
    userAgent: null,
    deviceName: null,
    systemName: null,
    formFactor: null,
    tvPlatform: null,
    nowPlaying: null,
  };

  it('keeps the previous target list when a refresh fails', async () => {
    const { service } = setup();
    const httpMock = TestBed.inject(HttpTestingController);

    const first = service.refreshTargets();
    httpMock.expectOne((req) => req.url === '/api/remote/targets').flush([target]);
    await first;
    expect(service.targets()).toEqual([target]);

    const second = service.refreshTargets();
    httpMock
      .expectOne((req) => req.url === '/api/remote/targets')
      .flush(null, { status: 500, statusText: 'Server Error' });
    await second;

    expect(service.targets()).toEqual([target]);
  });
});

/**
 * A selection persisted by an earlier run routed playback the moment the app
 * booted, so opening a title landed on the remote surface with "not reachable"
 * while the topbar — which reads the live listing — showed no device at all.
 */
describe('RemoteService restored selection', () => {
  const target: RemoteTarget = {
    targetId: 'tv#1',
    userAgent: null,
    deviceName: null,
    systemName: null,
    formFactor: null,
    tvPlatform: null,
    nowPlaying: null,
  };

  function bootWith(stored: string) {
    localStorage.setItem('fliks.remote.target', stored);
    const { service } = setup();
    service.selectedTargetId.set(null);
    return service;
  }

  it('does not route playback before a listing confirms the stored target', () => {
    const service = bootWith('tv#1');
    expect(service.selectedTargetId()).toBeNull();
  });

  it('promotes the stored target once it is listed', async () => {
    const service = bootWith('tv#1');
    const httpMock = TestBed.inject(HttpTestingController);
    const done = service.refreshTargets();
    httpMock.expectOne((req) => req.url === '/api/remote/targets').flush([target]);
    await done;

    expect(service.selectedTargetId()).toBe('tv#1');
    expect(service.targetOffline()).toBe(false);
  });

  it('forgets a stored target the listing does not have', async () => {
    const service = bootWith('tv#gone');
    const httpMock = TestBed.inject(HttpTestingController);
    const done = service.refreshTargets();
    httpMock.expectOne((req) => req.url === '/api/remote/targets').flush([target]);
    await done;

    expect(service.selectedTargetId()).toBeNull();
    expect(service.targetOffline()).toBe(false);
    expect(localStorage.getItem('fliks.remote.target')).toBeNull();
  });
});
