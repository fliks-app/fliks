import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { RemoteService } from './remote.service';
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
    quality: '1080p',
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
  return { service, remoteState };
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
