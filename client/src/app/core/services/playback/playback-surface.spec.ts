import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { RemoteAudioOutput } from '../audio-player/remote-audio-output';
import { DeviceService } from '../device.service';
import { RemoteService } from '../remote.service';
import { SessionSyncService, type AccountSession } from '../session-sync.service';
import { ServerVersionService } from '../server-version.service';
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

let observed = true;
const viewObserved = vi.fn();
const audioExpand = vi.fn();

function setup(role: 'owner' | 'observer' = 'observer', holdsPlayer = false, serverSupports = true) {
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
          isAudio: SessionSyncService.prototype.isAudio,
          observedOwnerTargetId: () => (observed ? 'tv' : null),
        },
      },
      { provide: PlaybackSession, useValue: { isLocal: () => true, partyActive: () => false, viewObserved } },
      { provide: RemoteAudioOutput, useValue: { expand: audioExpand } },
      { provide: DeviceService, useValue: { isTv: () => false } },
      { provide: AudioPlayerService, useValue: { track: () => null, active: () => false } },
      { provide: RemoteService, useValue: {} },
      { provide: SseService, useValue: { connectionId } },
      { provide: ServerVersionService, useValue: { supports: () => serverSupports } },
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

describe('PlaybackSurface keepalive on an older server', () => {
  it('sends nothing: the route does not exist there', () => {
    vi.useFakeTimers();
    const { connectionId, http } = setup('observer', false, false);
    connectionId.set('c1');
    TestBed.tick();
    vi.advanceTimersByTime(60_000);
    http.expectNone('/api/system/events/keepalive');
    vi.useRealTimers();
  });
});

describe('PlaybackSurface bar', () => {
  it('holds the session of an owner without a player as parked, with no bar', () => {
    const { session, surface } = setup('owner', false);
    session.set(playing());
    TestBed.tick();
    expect(surface.state()).toBe('parked');
    expect(surface.bar()).toBeNull();
  });

  it('shows parked music as the mini-player, and no parked item as a bar', () => {
    const { session, surface } = setup();
    session.set(playing({ state: 'parked', item: { id: 5, kind: 'album' } as AccountSession['item'] }));
    TestBed.tick();
    expect(surface.bar()).toBeNull();
    expect(surface.parkedMusic()).toBe(true);

    session.set(playing({ state: 'parked', item: { id: 6, kind: 'movie' } as AccountSession['item'] }));
    TestBed.tick();
    expect(surface.bar()).toBeNull();
    expect(surface.parkedMusic()).toBe(false);
  });

  it('keeps an owner with a player local, with no bar', () => {
    const { session, surface } = setup('owner', true);
    session.set(playing());
    TestBed.tick();
    expect(surface.state()).toBe('local');
    expect(surface.bar()).toBeNull();
  });
});

describe('PlaybackSurface open', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    observed = true;
  });

  it('opens no video view for a parked session or an item without a file', () => {
    const video = { id: 5, mediaId: 3, mediaFileId: 9, kind: 'movie', family: 'video' } as AccountSession['item'];
    const { surface } = setup();
    observed = false;
    surface.open(playing({ item: video }));
    observed = true;
    surface.open(playing({ item: { ...video, mediaFileId: null } }));
    expect(viewObserved).not.toHaveBeenCalled();
    expect(surface.canOpen(playing({ item: video }))).toBe(true);
  });

  it('opens the audio player for an audio session and the video player for any other family', () => {
    const { surface } = setup();
    surface.open(playing({ item: { id: 5, kind: 'album', family: 'audio' } as AccountSession['item'] }));
    expect(audioExpand).toHaveBeenCalledOnce();
    expect(viewObserved).not.toHaveBeenCalled();
    surface.open(playing({ item: { id: 5, mediaId: 3, mediaFileId: 9, episodeId: 2, kind: 'movie', family: 'video' } as AccountSession['item'] }));
    expect(viewObserved).toHaveBeenCalledWith({ fileId: 9, mediaId: 3, episodeId: 2 });
  });
});
