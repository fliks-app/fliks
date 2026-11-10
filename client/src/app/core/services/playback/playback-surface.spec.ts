import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { DeviceService } from '../device.service';
import { RemoteService } from '../remote.service';
import { SessionSyncService } from '../session-sync.service';
import { SseService } from '../sse.service';
import { PlaybackSession } from './playback-session';
import { PlaybackSurface } from './playback-surface';

function setup() {
  const connectionId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SessionSyncService, useValue: { session: signal(null), holdsPlayer: signal(false) } },
      { provide: PlaybackSession, useValue: {} },
      { provide: DeviceService, useValue: {} },
      { provide: AudioPlayerService, useValue: {} },
      { provide: RemoteService, useValue: {} },
      { provide: SseService, useValue: { connectionId } },
    ],
  });
  TestBed.inject(PlaybackSurface);
  return { connectionId, http: TestBed.inject(HttpTestingController) };
}

describe('PlaybackSurface keepalive', () => {
  afterEach(() => vi.useRealTimers());

  it('tells the server it reads the stream now and every 30 s, until the stream goes', () => {
    vi.useFakeTimers();
    const { connectionId, http } = setup();
    TestBed.tick();
    http.expectNone('/api/system/events/keepalive');

    connectionId.set('c1');
    TestBed.tick();
    http.expectOne('/api/system/events/keepalive').flush(null, { status: 204, statusText: 'No Content' });

    vi.advanceTimersByTime(30_000);
    const next = http.expectOne('/api/system/events/keepalive');
    expect(next.request.body).toEqual({ connectionId: 'c1' });
    next.flush(null, { status: 404, statusText: 'Not Found' });

    connectionId.set(null);
    TestBed.tick();
    vi.advanceTimersByTime(60_000);
    http.expectNone('/api/system/events/keepalive');
  });
});
