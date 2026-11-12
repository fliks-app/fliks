import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { KaraokeApiService } from '../api/karaoke-api.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { MediaService } from '../api/media.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { ServerConfigService } from '../server-config.service';
import { StorageScopeService } from '../storage-scope.service';
import { AuthService } from '../auth.service';
import { CastService } from '../cast.service';
import { CastPlayerService } from '../cast-player.service';
import { NATIVE_AUDIO } from '../../plugins/audio-player.plugin';
import { AudioPlayerService, type AudioPartyRouter } from './audio-player.service';
import type { MusicTrackRequest } from './music-queue';
import { SessionSyncService } from '../session-sync.service';
import { RemoteService } from '../remote.service';
import { MusicApiService } from '../api/music-api.service';
import type { RemoteCommand } from '../sse.service';
import { Subject } from 'rxjs';
import { PlayerStateService } from '../player-state.service';

const track = (id: number): MusicTrackRequest => ({
  itemId: id,
  mediaId: 1,
  title: `T${id}`,
  artists: 'A',
  albumTitle: 'Al',
  coverUrl: null,
  durationSeconds: 100,
  gain: null,
  peak: null,
  albumGain: null,
  albumPeak: null,
});

describe('AudioPlayerService on the native player', () => {
  const handlers = new Map<string, (e: unknown) => void>();
  const plugin = Object.fromEntries(
    ['configure', 'attach', 'detach', 'setQueue', 'updateQueue', 'loadParts', 'play', 'pause', 'seek', 'skipTo', 'setRate', 'setGain', 'setRepeat', 'setRouted', 'stop', 'setStems', 'setStemMix', 'clearStems'].map(
      (m) => [m, vi.fn().mockResolvedValue(undefined)],
    ),
  ) as Record<string, ReturnType<typeof vi.fn>>;
  const updatePlaybackState = vi.fn();
  const getItemPlaybackInfo = vi.fn();
  const refreshAccessToken = vi.fn().mockResolvedValue(true);
  const user = signal<{ id: number } | null>({ id: 1 });
  const emit = (event: string, e: unknown) => handlers.get(event)!(e);

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    for (const fn of Object.values(plugin)) fn.mockClear();
    updatePlaybackState.mockReset().mockResolvedValue(null);
    getItemPlaybackInfo.mockReset();
    refreshAccessToken.mockClear();
    user.set({ id: 1 });
    (plugin as unknown as { addListener: unknown }).addListener = vi.fn(async (event: string, fn: (e: unknown) => void) => {
      handlers.set(event, fn);
      return { remove: async () => undefined };
    });
    TestBed.configureTestingModule({
      providers: [
      { provide: RemoteService, useValue: { registerLoader: vi.fn(), isRemoting: () => false, validated: new Subject<RemoteCommand>(), markApplied: vi.fn(), lastAppliedCmdId: signal<string | null>(null) } },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async () => []) } },
      { provide: SessionSyncService, useValue: { registerPlayer: () => () => {}, registerResumer: () => () => {}, handleSuperseded: vi.fn(), handoffFor: () => undefined } },
        provideZonelessChangeDetection(),
        { provide: PlayerStateService, useValue: { volume: signal(1) } },
        { provide: NATIVE_AUDIO, useValue: plugin },
        { provide: StreamingApiService, useValue: { getItemPlaybackInfo, updatePlaybackState, stopSession: vi.fn().mockResolvedValue(undefined), buildPlayUrl: (pi: { playUrl: string }) => pi.playUrl, positionRequest: () => ({ url: '/x', init: {} }), stopSessionRequest: () => ({ url: '/x', init: {} }) } },
        { provide: AuthService, useValue: { refreshAccessToken, user } },
        { provide: CastService, useValue: { isConnected: signal(false), currentTime: signal(0), isPaused: signal(true), ended: signal(false) } },
        { provide: CastPlayerService, useValue: {} },
        { provide: BrowserDeviceProfileService, useValue: { getProfile: () => ({ deviceType: 'x', directPlayProfiles: [] }), whenNativeProbed: async () => undefined } },
        { provide: MediaService, useValue: {} },
        { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u, serverUrl: () => '' } },
        { provide: StorageScopeService, useValue: { suffix: () => 's', canPersist: () => true, scope: () => 's' } },
      ],
    });
  });

  it('mixes stems in the native player only in a stem mode, and drops them when the track changes', async () => {
    const platform = vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: KaraokeApiService,
          useValue: {
            itemState: vi.fn().mockResolvedValue({ state: 'ready', fileId: 10, stems: { instrumental: {}, vocals: {} } }),
            stemUrl: (f: number, k: string) => `https://s/${f}/${k}`,
          },
        },
      ],
    });
    const audio = TestBed.inject(AudioPlayerService);
    platform.mockRestore();
    expect(audio.stemsNative).toBe(false);
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    await vi.waitFor(() => expect(audio.stemsAvailable()).toBe(true));
    expect(plugin['setStems']).not.toHaveBeenCalled();
    audio.setStemMode('instrumental');
    await vi.waitFor(() => expect(plugin['setStemMix']).toHaveBeenCalledWith({ main: 0, instrumental: 1, vocals: 0 }));
    expect(plugin['setStems']).toHaveBeenCalledWith({ key: '10', instrumentalUrl: 'https://s/10/instrumental', vocalsUrl: 'https://s/10/vocals' });
    emit('stems', { state: 'failed' });
    expect(audio.stemMode()).toBe('original');
    expect(plugin['clearStems']).toHaveBeenCalled();
  });

  it('attaches with the device profile and hands the music queue over without resolving streams', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await vi.waitFor(() => expect(plugin['attach']).toHaveBeenCalled());
    const sent = JSON.parse(plugin['configure']!.mock.calls[0]![0].deviceProfile);
    expect(sent.deviceType).toBe('x');
    await audio.playTracks([track(1), track(2)], 1);
    expect(getItemPlaybackInfo).not.toHaveBeenCalled();
    expect(plugin['setQueue']).toHaveBeenCalledWith({ tracks: [track(1), track(2)], index: 1, autoplay: true });
    expect(audio.track()?.itemId).toBe(2);
  });

  it('follows the native track, position and play state, and beats with the resolved session', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    emit('state', { playing: true, playWhenReady: true, buffering: false, ready: true, ended: false });
    emit('position', { index: 0, position: 12, duration: 98 });
    expect(audio.playing()).toBe(true);
    expect(audio.position()).toBe(12);
    TestBed.tick();
    expect(audio.duration()).toBe(98);
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, mediaFileId: 10, sessionId: 's1' }));
    emit('track', { index: 1, itemId: 2, mediaFileId: 20, sessionId: 's2' });
    expect(audio.track()?.itemId).toBe(2);
    expect(audio.queueIndex()).toBe(1);
    expect(audio.position()).toBe(0);
  });

  it('counts a position jump only between consecutive position events', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const now = vi.spyOn(Date, 'now');
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    now.mockReturnValue(1_000);
    emit('state', { playing: true, playWhenReady: true, buffering: false, ready: true, ended: false });
    emit('position', { index: 0, position: 10, duration: 98 });
    emit('state', { playing: false, playWhenReady: false, buffering: false, ready: true, ended: false });
    now.mockReturnValue(60_000);
    emit('state', { playing: true, playWhenReady: true, buffering: false, ready: true, ended: false });
    updatePlaybackState.mockClear();
    now.mockReturnValue(60_100);
    emit('position', { index: 0, position: 10.1, duration: 98 });
    expect(updatePlaybackState).not.toHaveBeenCalled();
    now.mockReturnValue(60_600);
    emit('position', { index: 0, position: 50, duration: 98 });
    expect(updatePlaybackState).toHaveBeenCalledTimes(1);
  });

  it('keeps the session of the native track it adopted when a beat of the previous one is answered lost', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    TestBed.tick();
    let answer!: (r: { sessionLost: boolean }) => void;
    updatePlaybackState.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    emit('state', { playing: true, playWhenReady: true, buffering: false, ready: true, ended: false });
    TestBed.tick();
    emit('track', { index: 1, itemId: 2, mediaFileId: 20, sessionId: 's2' });
    answer({ sessionLost: true });
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenCalled());
    await Promise.resolve();
    emit('state', { playing: false, playWhenReady: false, buffering: false, ready: true, ended: false });
    TestBed.tick();
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 2, sessionId: 's2' }));
  });

  it('drops the session of a beat the server answers lost', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    TestBed.tick();
    updatePlaybackState.mockResolvedValueOnce({ sessionLost: true });
    emit('state', { playing: true, playWhenReady: true, buffering: false, ready: true, ended: false });
    TestBed.tick();
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenCalled());
    await Promise.resolve();
    emit('state', { playing: false, playWhenReady: false, buffering: false, ready: true, ended: false });
    TestBed.tick();
    expect(updatePlaybackState.mock.lastCall?.[1].sessionId).toBeUndefined();
  });

  it('skips and seeks through the native player', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    audio.next();
    await vi.waitFor(() => expect(plugin['skipTo']).toHaveBeenCalledWith({ index: 1 }));
    await audio.seek(30);
    expect(plugin['seek']).toHaveBeenCalledWith({ position: 30 });
    audio.setShuffle(true);
    await vi.waitFor(() => expect(plugin['updateQueue']).toHaveBeenCalled());
  });

  it('adopts a queue the native side built', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await vi.waitFor(() => expect(plugin['attach']).toHaveBeenCalled());
    emit('queue', { tracks: [track(5), track(6)], index: 1 });
    expect(audio.musicMode()).toBe(true);
    expect(audio.track()?.itemId).toBe(6);
    expect(audio.queue().length).toBe(2);
  });

  it('routes controls from outside the app to the party', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const seen: string[] = [];
    const router: AudioPartyRouter = (c) => {
      seen.push(c.type);
      return true;
    };
    audio.setPartyRouter(router);
    await vi.waitFor(() => expect(plugin['setRouted']).toHaveBeenCalledWith({ routed: true }));
    await audio.openForParty(track(1));
    emit('command', { command: 'next', value: 0 });
    emit('command', { command: 'seek', value: 9 });
    expect(seen).toContain('next');
    expect(seen).toContain('seek');
  });

  it('plays an audiobook through its parts and maps the part position onto the book timeline', async () => {
    getItemPlaybackInfo.mockResolvedValue({
      playMethod: 'DirectPlay',
      playUrl: '/a',
      mediaFileId: 7,
      sessionId: 'b',
      durationSeconds: 200,
      startAtSeconds: 130,
      parts: [
        { index: 0, playUrl: '/p0', offsetS: 0, durationS: 100, contentType: 'audio/mpeg' },
        { index: 1, playUrl: '/p1', offsetS: 100, durationS: 100, contentType: 'audio/mpeg' },
      ],
    });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play({ mediaId: 3, itemId: 9, title: 'Book' });
    expect(plugin['loadParts']).toHaveBeenCalledWith(expect.objectContaining({
        index: 1,
        startAt: 30,
        parts: [{ url: '/p0' }, { url: '/p1' }],
        book: { mediaId: 3, itemId: 9, mediaFileId: 7, sessionId: 'b', durationSeconds: 200, offsets: [0, 100] },
      }),
    );
    emit('position', { index: 1, position: 40, duration: 100 });
    expect(audio.position()).toBe(140);
    await audio.seek(10);
    expect(plugin['seek']).toHaveBeenCalledWith({ position: 10, index: 0 });
  });

  it('steps back instead of rewinding a book without chapters to its start', async () => {
    getItemPlaybackInfo.mockResolvedValue({
      playMethod: 'DirectPlay',
      playUrl: '/a',
      mediaFileId: 7,
      sessionId: 'b',
      durationSeconds: 1000,
      startAtSeconds: 500,
    });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play({ mediaId: 3, itemId: 9, title: 'Book' });
    emit('position', { index: 0, position: 500, duration: 1000 });
    plugin['seek']!.mockClear();
    audio.previousChapter();
    await vi.waitFor(() => expect(plugin['seek']).toHaveBeenCalledWith({ position: 485, index: 0 }));
  });

  it('drops the queue and the track when the account leaves, without a progress beat', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    emit('track', { index: 0, itemId: 1, mediaFileId: 10, sessionId: 's1' });
    TestBed.tick();
    updatePlaybackState.mockClear();
    user.set(null);
    TestBed.tick();
    await vi.waitFor(() => expect(audio.track()).toBeNull());
    expect(plugin['stop']).toHaveBeenCalled();
    expect(updatePlaybackState).not.toHaveBeenCalled();
  });

  it('has the web layer refresh the session when the native side gets a 401', async () => {
    TestBed.inject(AudioPlayerService);
    await vi.waitFor(() => expect(plugin['attach']).toHaveBeenCalled());
    emit('refresh', undefined);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
