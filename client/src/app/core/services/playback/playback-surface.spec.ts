import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { DeviceService } from '../device.service';
import { RemoteService } from '../remote.service';
import { SessionSyncService, type AccountSession } from '../session-sync.service';
import { SseService } from '../sse.service';
import { PlaybackSession } from './playback-session';
import { PlaybackSurface } from './playback-surface';

const playing = (o: Partial<AccountSession> = {}) =>
  ({
    epoch: 1,
    item: { id: 5 },
    owner: { targetId: 'tv', deviceName: 'TV', formFactor: 'tv' },
    state: 'playing',
    ...o,
  }) as unknown as AccountSession;

function setup(role: 'owner' | 'observer' = 'observer', holdsPlayer = false) {
  const connectionId = signal<string | null>(null);
  const session = signal<AccountSession | null>(null);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: SessionSyncService,
        useValue: {
          session,
          holdsPlayer: signal(holdsPlayer),
          role: () => (session() ? role : 'none'),
          localPlaying: () => false,
          claimPending: () => false,
          ownedHere: () => role === 'owner',
          isReading: () => false,
        },
      },
      { provide: PlaybackSession, useValue: { isLocal: () => true, partyActive: () => false } },
      { provide: DeviceService, useValue: { isTv: () => false } },
      { provide: AudioPlayerService, useValue: { track: () => null, active: () => false } },
      { provide: RemoteService, useValue: {} },
      { provide: SseService, useValue: { connectionId } },
    ],
  });
  TestBed.inject(PlaybackSurface);
  return { connectionId, session, surface: TestBed.inject(PlaybackSurface), http: TestBed.inject(HttpTestingController) };
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

describe('PlaybackSurface bar', () => {
  it('shows the session an owner without a player holds as parked, local once a player mounts', () => {
    const { session, surface } = setup('owner', false);
    session.set(playing());
    TestBed.tick();
    expect(surface.state()).toBe('parked');
    expect(surface.bar()).not.toBeNull();
  });

  it('keeps an owner with a player local, with no bar', () => {
    const { session, surface } = setup('owner', true);
    session.set(playing());
    TestBed.tick();
    expect(surface.state()).toBe('local');
    expect(surface.bar()).toBeNull();
  });

  it('shows the bar of the next playback of an owner whose earlier bar was hidden', () => {
    const { session, surface } = setup();
    session.set(playing({ item: { id: 1 } as AccountSession['item'] }));
    TestBed.tick();
    surface.hide();
    TestBed.tick();
    expect(surface.bar()).toBeNull();

    session.set(playing({ state: 'parked' }));
    TestBed.tick();
    expect(surface.bar()).not.toBeNull();

    session.set(playing({ item: { id: 2 } as AccountSession['item'] }));
    TestBed.tick();
    expect(surface.bar()).not.toBeNull();
  });

  it('keeps a hidden bar hidden when the owner passes from its web layer to its native service', () => {
    const { session, surface } = setup();
    session.set(playing({ owner: { targetId: 'dev#ab12', deviceName: null, formFactor: null } }));
    TestBed.tick();
    surface.hide();
    session.set(playing({ owner: { targetId: 'dev#native', deviceName: 'Phone', formFactor: 'phone' } }));
    TestBed.tick();
    expect(surface.bar()).toBeNull();
  });

  it('keeps the bar hidden while the same playback moves to its next track', () => {
    const { session, surface } = setup();
    session.set(playing());
    TestBed.tick();
    surface.hide();
    session.set(playing({ item: { id: 6 } as AccountSession['item'] }));
    TestBed.tick();
    expect(surface.bar()).toBeNull();
  });
});
