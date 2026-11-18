import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { MediaService } from '../api/media.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { ServerConfigService } from '../server-config.service';
import { StorageScopeService } from '../storage-scope.service';
import { KaraokeApiService } from '../api/karaoke-api.service';
import { MusicCastOutput, type MusicCastHost } from './music-cast-output';
import { AudioPlayerService } from './audio-player.service';
import { PlaybackSession } from '../playback/playback-session';
import type { MusicTrackRequest } from './music-queue';
import { SessionSyncService } from '../session-sync.service';
import { FullPlayerState } from '../playback/full-player-state';
import { RemoteService, type RemoteCommandInput } from '../remote.service';
import { MusicApiService } from '../api/music-api.service';
import type { RemoteCommand } from '../sse.service';
import { Subject } from 'rxjs';
import { PlayerStateService } from '../player-state.service';
import { TvService } from '../tv.service';

const track = (id: number, extra: Partial<MusicTrackRequest> = {}): MusicTrackRequest => ({
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
  ...extra,
});

const partyRouter = signal<((c: never, p: string) => boolean) | null>(null);

describe('AudioPlayerService music mode', () => {
  const getItemPlaybackInfo = vi.fn();
  const updatePlaybackState = vi.fn();
  let observedOwner: string | null = null;
  let ownerCanEnqueue = true;
  const stopSession = vi.fn();
  const castLoad = vi.fn();
  const itemState = vi.fn();
  let host: MusicCastHost;
  const castOut = {
    active: signal(false),
    isConnected: signal(false),
    load: async (...a: unknown[]) => {
      const info = await castLoad(...a);
      if (info) castOut.active.set(true);
      return info;
    },
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(() => castOut.active.set(false)),
    release: vi.fn(() => castOut.active.set(false)),
    queueNext: vi.fn(),
    hasNext: () => false,
    dropNext: vi.fn(),
    setStemSource: vi.fn(),
    applyStems: vi.fn(async () => {}),
    clearStems: vi.fn(),
    attach: (h: MusicCastHost) => ((host = h), () => {}),
  };
  type Loader = (cmd: RemoteCommand) => Promise<void>;
  const loaders: Record<string, Loader> = {};
  let player: { yield(): Promise<unknown> } | undefined;
  const resumers: Record<string, (s: unknown, at: number) => Promise<void>> = {};
  let validated = new Subject<RemoteCommand>();
  const markApplied = vi.fn();
  const send = vi.fn(async (_id: string, _input: RemoteCommandInput) => undefined);
  let playTarget: string | null = null;
  const trackRequests = vi.fn(async (ids: readonly number[]) => ids.map((i) => track(i)));
  const cmd = (action: RemoteCommand['action'], extra: Partial<RemoteCommand> = {}): RemoteCommand => ({
    type: 'remote.command', cmdId: 'c1', expiresAt: Date.now() + 10_000, byTargetId: null, action, ...extra,
  });
  const els = (a: AudioPlayerService) => (a as unknown as { els: HTMLAudioElement[] }).els;

  beforeEach(() => {
    partyRouter.set(null);
    localStorage.clear();
    observedOwner = null;
    ownerCanEnqueue = true;
    validated = new Subject<RemoteCommand>();
    markApplied.mockClear();
    send.mockClear();
    playTarget = null;
    trackRequests.mockClear();
    castOut.active.set(false);
    castOut.isConnected.set(false);
    for (const f of [castOut.play, castOut.pause, castOut.toggle, castOut.seek, castOut.stop, castOut.release, castOut.queueNext, castOut.dropNext, castOut.setStemSource, castOut.clearStems]) f.mockClear();
    castLoad.mockReset();
    getItemPlaybackInfo.mockImplementation(async (itemId: number) => ({
      playMethod: 'DirectPlay',
      playUrl: `/s/${itemId}`,
      mediaFileId: itemId * 10,
      sessionId: `sid${itemId}`,
      startAtSeconds: 42,
      durationSeconds: 100,
      parts: [{ index: 0, playUrl: `/s/${itemId}`, offsetS: 0, durationS: 100, contentType: 'audio/flac' }],
    }));
    updatePlaybackState.mockResolvedValue(null);
    stopSession.mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
      { provide: RemoteService, useValue: { registerLoader: (f: string, l: Loader) => (loaders[f] = l), playTarget: () => playTarget, send, observedCan: () => ownerCanEnqueue, validated: { subscribe: (fn: (c: RemoteCommand) => void) => validated.subscribe(fn) }, markApplied, lastAppliedCmdId: signal<string | null>(null) } },
      { provide: MusicApiService, useValue: { trackRequests } },
      { provide: SessionSyncService, useValue: { registerPlayer: (p: unknown) => ((player = p as { yield(): Promise<unknown> }), () => {}), registerResumer: (f: string, r: (s: unknown, at: number) => Promise<void>) => ((resumers[f] = r), () => {}), handleSuperseded: vi.fn(), handoffFor: () => undefined, observedOwnerTargetId: () => observedOwner, session: () => ({ queue: { itemIds: [7, 8, 9], index: 1 } }) } },
        provideZonelessChangeDetection(),
        { provide: PlaybackSession, useValue: { toParty: (c: never, p: string) => partyRouter()?.(c, p) ?? false } },
        { provide: PlayerStateService, useValue: { volume: signal(1) } },
        {
          provide: StreamingApiService,
          useValue: {
            getItemPlaybackInfo,
            updatePlaybackState,
            stopSession,
            buildPlayUrl: (pi: { playUrl: string }) => pi.playUrl,
            positionRequest: () => ({ url: '/x', init: {} }),
            stopSessionRequest: () => ({ url: '/x', init: {} }),
          },
        },
        { provide: MusicCastOutput, useValue: castOut },
        { provide: KaraokeApiService, useValue: { itemState } },
        { provide: BrowserDeviceProfileService, useValue: { getProfile: () => ({}) } },
        { provide: MediaService, useValue: {} },
        { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u, serverUrl: () => '' } },
        { provide: StorageScopeService, useValue: { suffix: () => 's', canPersist: () => true, scope: () => 's' } },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('starts at 0 ignoring any resume point and heartbeats with the track item id', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    expect(getItemPlaybackInfo).toHaveBeenCalledWith(1, {}, { startAt: 0 });
    expect(audio.musicMode()).toBe(true);
    expect(audio.position()).toBe(0);
    expect(audio.queue().length).toBe(2);
    els(audio)[0].dispatchEvent(new Event('play'));
    TestBed.tick();
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, mediaFileId: 10, sessionId: 'sid1' }));
  });

  it('moves the open remote view to the local player once "play here" has loaded the session', async () => {
    TestBed.inject(AudioPlayerService);
    const full = TestBed.inject(FullPlayerState);
    full.show('audio', true);
    const item = { id: 1, mediaId: 1, kind: 'album' };
    await resumers['audio']({ item, state: 'paused', queue: { itemIds: [1], index: 0, shuffle: false, repeat: 'off' } }, 30);
    expect([full.open(), full.remote()]).toEqual(['audio', false]);
  });

  it('beats at once when "play here" loads a paused session, which reports no play state', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const item = { id: 1, mediaId: 1, kind: 'album' };
    await resumers['audio']({ item, state: 'paused', queue: { itemIds: [1], index: 0, shuffle: false, repeat: 'off' } }, 30);
    expect(audio.playing()).toBe(false);
    TestBed.tick();
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, state: 'paused', sessionId: 'sid1' }));
  });

  it('beats too when the session track is unavailable and the next one of the queue loads', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    trackRequests.mockImplementationOnce(async () => [track(2)]);
    const item = { id: 1, mediaId: 1, kind: 'album' };
    await resumers['audio']({ item, state: 'paused', queue: { itemIds: [1, 2], index: 0, shuffle: false, repeat: 'off' } }, 30);
    expect(audio.playing()).toBe(false);
    TestBed.tick();
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 2, state: 'paused' }));
    expect(getItemPlaybackInfo).toHaveBeenCalledWith(2, {}, { startAt: 0 });
  });

  it('claims nothing when another start overtakes a paused "play here"', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    let release!: () => void;
    trackRequests.mockImplementationOnce(async (ids) => {
      await new Promise<void>((r) => (release = r));
      return ids.map((i) => track(i));
    });
    const item = { id: 1, mediaId: 1, kind: 'album' };
    const pending = resumers['audio']({ item, state: 'paused', queue: { itemIds: [1], index: 0, shuffle: false, repeat: 'off' } }, 30);
    await audio.playTracks([track(1)]);
    updatePlaybackState.mockClear();
    release();
    await pending;
    expect(updatePlaybackState).not.toHaveBeenCalled();
  });

  it('re-opens the track in another key at the same position, and back to the original', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    (audio as unknown as { _position: { set(n: number): void } })._position.set(30);
    await audio.setPitch(40);
    expect(audio.pitch()).toBe(12);
    expect(getItemPlaybackInfo).toHaveBeenLastCalledWith(1, {}, { startAt: 30, pitchSemitones: 12 });
    expect(stopSession).toHaveBeenCalledWith('sid1');
    await audio.setPitch(0);
    expect(audio.pitch()).toBe(0);
    expect(getItemPlaybackInfo).toHaveBeenLastCalledWith(1, {}, { startAt: 30, pitchSemitones: 0 });
  });

  it('plays a Direct Play file the element cannot open again as a transcode, from the same position', async () => {
    // The transcode loads through the element's own HLS support, not Shaka.
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    (audio as unknown as { _position: { set(n: number): void } })._position.set(30);
    getItemPlaybackInfo.mockResolvedValueOnce({
      playMethod: 'Transcode',
      playUrl: '/hls/1',
      mediaFileId: 10,
      sessionId: 'sid1b',
      durationSeconds: 100,
    });
    els(audio)[0].dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith('sid1'));
    expect(getItemPlaybackInfo).toHaveBeenLastCalledWith(1, { rejectCopy: true }, { startAt: 30 });
    expect((audio as unknown as { info: { sessionId: string } }).info.sessionId).toBe('sid1b');
  });

  it('goes to the next track, and restarts the current one when past 3 seconds', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)], 1);
    expect(audio.track()?.itemId).toBe(2);
    els(audio)[0].currentTime = 10;
    els(audio)[0].dispatchEvent(new Event('timeupdate'));
    audio.previous();
    expect(audio.track()?.itemId).toBe(2);
    expect(els(audio)[0].currentTime).toBe(0);
    audio.previous();
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(1));
    audio.next();
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
  });

  it('takes its level from the full player and reports it to the other devices once settled', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    audio.setVolume(0.4);
    audio.setVolume(0.3);
    expect(audio.volume()).toBe(0.3);
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ volume: 0.3, muted: false })));
    audio.toggleMute();
    expect(audio.muted()).toBe(true);
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ volume: 0.3, muted: true })));
  });

  it('reports a stem mode at once and a dragged vocal level once settled', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    audio.setStemMode('instrumental');
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ stemMode: 'instrumental' })));
    audio.setVocalLevel(0.4);
    audio.setVocalLevel(0.6);
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ stemMode: 'guide', vocalLevel: 0.6 })));
  });

  it('reports a skip as playing while the next track loads, never as a pause', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    els(audio)[0].dispatchEvent(new Event('play'));
    TestBed.tick();
    updatePlaybackState.mockClear();
    audio.next();
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
    TestBed.tick();
    await vi.waitFor(() => expect(updatePlaybackState.mock.calls.some((c) => c[1].itemId === 2)).toBe(true));
    expect(updatePlaybackState.mock.calls.map((c) => c[1].state)).not.toContain('paused');
  });

  it('shows the track a skip moves to before it has loaded', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    audio.next();
    expect(audio.track()?.itemId).toBe(1);
    expect(audio.uiTrack()?.itemId).toBe(2);
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
    expect(audio.uiTrack()).toBe(audio.track());
  });

  it('preloads the next track near the end and starts it on the standby element at ended', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    const [a, b] = els(audio);
    a.dispatchEvent(new Event('play'));
    a.currentTime = 90;
    a.dispatchEvent(new Event('timeupdate'));
    await vi.waitFor(() => expect(b.getAttribute('src')).toBe('/s/2'));
    a.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
    expect(getItemPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(stopSession).not.toHaveBeenCalled();
    expect(updatePlaybackState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 'sid1', state: 'playing' }));
    TestBed.tick();
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith('sid1'));
    expect(updatePlaybackState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 'sid2', state: 'playing' }));
  });

  it('does not load the next track on a second element on webOS, then plays it at ended', async () => {
    TestBed.overrideProvider(TvService, { useValue: new Proxy({}, { get: (_, k) => () => k === 'isWebOs' }) });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    const [a, b] = els(audio);
    a.dispatchEvent(new Event('play'));
    a.currentTime = 90;
    a.dispatchEvent(new Event('timeupdate'));
    await Promise.resolve();
    expect(b.getAttribute('src')).toBeNull();
    a.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
  });

  it('stops at the end of the queue with repeat off and wraps with repeat all', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    els(audio)[0].dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(audio.playing()).toBe(false));
    expect(audio.track()?.itemId).toBe(1);
    audio.cycleRepeat();
    expect(audio.repeat()).toBe('all');
    els(audio)[0].dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(getItemPlaybackInfo).toHaveBeenCalledTimes(2));
  });

  it('asks the observed owner to enqueue instead of playing when nothing plays here', () => {
    const audio = TestBed.inject(AudioPlayerService);
    observedOwner = 'pc#1';
    audio.enqueueTracks([track(3)], 'next');
    audio.enqueueTracks([track(4)], 'last');
    expect(send).toHaveBeenNthCalledWith(1, 'pc#1', { action: 'enqueue', itemIds: [3], where: 'next' });
    expect(send).toHaveBeenNthCalledWith(2, 'pc#1', { action: 'enqueue', itemIds: [4], where: 'last' });
    expect(audio.track()).toBeNull();
  });

  it('plays here when the observed owner cannot enqueue', () => {
    const audio = TestBed.inject(AudioPlayerService);
    observedOwner = 'pc#1';
    ownerCanEnqueue = false;
    audio.enqueueTracks([track(3)], 'next');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the open full player on the session when another device takes it over', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const full = TestBed.inject(FullPlayerState);
    await audio.playTracks([track(1), track(2)]);
    audio.expand();
    await player!.yield();
    expect(audio.track()).toBeNull();
    expect([full.open(), full.remote()]).toEqual(['audio', true]);
  });

  it('closes the full player when this device stops on its own', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const full = TestBed.inject(FullPlayerState);
    await audio.playTracks([track(1)]);
    audio.expand();
    await audio.close();
    expect(full.open()).toBeNull();
  });

  it('leaves an open video player alone when it closes', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const full = TestBed.inject(FullPlayerState);
    await audio.playTracks([track(1)]);
    full.show('video', false);
    await audio.close();
    expect(full.open()).toBe('video');
  });

  it('enqueues after the current track and at the end', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    audio.enqueueTracks([track(3)], 'next');
    audio.enqueueTracks([track(4)], 'last');
    expect(audio.queue().map((t) => t.itemId)).toEqual([1, 3, 2, 4]);
  });

  it('attenuates by track ReplayGain with the preamp, and not at all when off', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1, { gain: -6 })]);
    expect(els(audio)[0].volume).toBeCloseTo(10 ** (-6 / 20));
    audio.setReplayGain('off');
    expect(els(audio)[0].volume).toBe(1);
    audio.setReplayGain('track');
    audio.setPreamp(3);
    expect(els(audio)[0].volume).toBeCloseTo(10 ** (-3 / 20));
    expect(JSON.parse(localStorage.getItem('fliks.audio.prefs')!)).toMatchObject({ replayGain: 'track', preamp: 3 });
  });

  it('leaves music mode when a book starts', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    await audio.play({ mediaId: 9, itemId: 90, title: 'Book' });
    expect(audio.musicMode()).toBe(false);
    expect(audio.queue()).toEqual([]);
  });

  const castInfo = (sessionId: string, mediaFileId: number, durationSeconds = 100) => ({ sessionId, mediaFileId, durationSeconds, playMethod: 'DirectPlay' });

  it('plays a track on the receiver when connected, and keeps the server session for the heartbeat', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs', 77));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    expect(castLoad).toHaveBeenCalledWith(expect.objectContaining({ itemId: 1 }), true, 0, expect.any(Function));
    expect(getItemPlaybackInfo).not.toHaveBeenCalled();
    expect(audio.playing()).toBe(true);
    audio.toggle();
    expect(castOut.toggle).toHaveBeenCalled();
    await audio.seek(30);
    expect(castOut.seek).toHaveBeenCalledWith(30);
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, mediaFileId: 77, sessionId: 'cs', positionSeconds: 30 }));
    await audio.close();
    expect(castOut.stop).toHaveBeenCalled();
  });

  it('resumes a snapshot here, from the same track', async () => {
    castLoad.mockResolvedValue(castInfo('cs', 10));
    castOut.isConnected.set(true);
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    await audio.resume({ track: track(1), position: 42, paused: false, karaoke: { mode: 'original', level: 0 } });
    expect(getItemPlaybackInfo).toHaveBeenLastCalledWith(1, {}, { startAt: 42 });
    expect(audio.isCasting()).toBe(false);
    expect(audio.track()?.itemId).toBe(1);
    expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2]);
    expect(castOut.stop).not.toHaveBeenCalled();
  });

  it('releases the music track with its position and play state, and plays it on the receiver when its cast output starts it', async () => {
    castLoad.mockResolvedValue(castInfo('cs', 77));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    els(audio)[0].dispatchEvent(new Event('play'));
    await audio.seek(30);
    expect(audio.holds()).toBe(true);
    const handoff = await audio.release();
    expect(handoff).toEqual({ kind: 'music', snapshot: { track: expect.objectContaining({ itemId: 1 }), position: 30, paused: false, karaoke: { mode: 'original', level: 0 } } });
    castOut.isConnected.set(true);
    await host.startOnCast(handoff!.snapshot);
    expect(castLoad).toHaveBeenCalledWith(expect.objectContaining({ itemId: 1 }), true, 30, expect.any(Function));
    expect(audio.isCasting()).toBe(true);
    expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2]);
  });

  it('keeps the stem mode and vocal level when the receiver takes the track', async () => {
    castLoad.mockResolvedValue(castInfo('cs', 77));
    itemState.mockResolvedValue({ state: 'ready', fileId: 77, stems: { instrumental: { contentType: 'audio/ogg' }, vocals: { contentType: 'audio/ogg' } } });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    audio.setStemMode('guide');
    audio.setVocalLevel(0.4);
    const handoff = await audio.release();
    expect(handoff?.snapshot.karaoke).toEqual({ mode: 'guide', level: 0.4 });
    castOut.isConnected.set(true);
    castOut.active.set(true);
    await host.startOnCast(handoff!.snapshot);
    await vi.waitFor(() => expect(castOut.applyStems).toHaveBeenCalled());
    expect(audio.stemMode()).toBe('guide');
    expect(audio.vocalLevel()).toBe(0.4);
  });

  it('offers stems on webOS, which plays them as buffers', async () => {
    itemState.mockResolvedValue({ state: 'ready', fileId: 77, stems: { instrumental: { contentType: 'audio/ogg' }, vocals: { contentType: 'audio/ogg' } } });
    vi.stubGlobal('AudioContext', class { destination = {}; createGain = () => ({ gain: { value: 0 }, connect: vi.fn() }); });
    TestBed.overrideProvider(TvService, { useValue: new Proxy({}, { get: (_, k) => () => k === 'isWebOs' }) });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    await audio.refreshStems();
    vi.unstubAllGlobals();
    expect(itemState).toHaveBeenCalled();
    expect(audio.stemsAvailable()).toBe(true);
  });

  it('starts a new track on the receiver in the original mix', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs', 77));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    audio.setStemMode('guide');
    await audio.playTracks([track(2)]);
    expect(audio.stemMode()).toBe('original');
  });

  it('resumes here in the stem mode the receiver played', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.resume({ track: track(1), position: 5, paused: false, karaoke: { mode: 'instrumental', level: 0 } });
    expect(audio.stemMode()).toBe('instrumental');
    expect(audio.vocalLevel()).toBe(0);
  });

  it('releases nothing for an audiobook, a party track or while loading', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play({ mediaId: 9, itemId: 90, title: 'Book' });
    expect(audio.holds()).toBe(true);
    expect(await audio.release()).toBeNull();
    await audio.playTracks([track(1)]);
    let open!: () => void;
    getItemPlaybackInfo.mockImplementationOnce(() => new Promise((r) => (open = () => r({ playMethod: 'DirectPlay', playUrl: '/s/2', mediaFileId: 20, sessionId: 's2', durationSeconds: 100, parts: [{ index: 0, playUrl: '/s/2', offsetS: 0, durationS: 100, contentType: 'audio/flac' }] }))));
    const loading = audio.playTracks([track(2)]);
    await vi.waitFor(() => expect(audio.loading()).toBe(true));
    expect(await audio.release()).toBeNull();
    open();
    await loading;
    partyRouter.set(((c: { type: string }) => c.type === 'external') as never);
    expect(await audio.release()).toBeNull();
  });

  it('steps aside by pausing the local engine, never the receiver', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    els(audio)[0].dispatchEvent(new Event('play'));
    audio.stepAside();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(castOut.pause).not.toHaveBeenCalled();
  });

  it('adopts a receiver track: queue, cursor and the receiver\'s session, beats with its sid, sends no LOAD', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    const queue = { itemIds: [1, 2, 3], index: 0, shuffle: false, repeat: 'all' as const };
    expect(await host.adopt({ itemId: 2, sid: 'rs', mediaFileId: 20, queue, stemMode: 'guide', vocalLevel: 0.3 })).toBe(true);
    expect(audio.track()?.itemId).toBe(2);
    expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2, 3]);
    expect(audio.queueIndex()).toBe(1);
    expect(audio.repeat()).toBe('all');
    expect(audio.stemMode()).toBe('guide');
    expect(audio.vocalLevel()).toBe(0.3);
    expect(castLoad).not.toHaveBeenCalled();
    expect(getItemPlaybackInfo).not.toHaveBeenCalled();
    TestBed.tick();
    await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 2, mediaFileId: 20, sessionId: 'rs' })));
  });

  it('refuses a receiver track while it plays something else', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    expect(await host.adopt({ itemId: 2, sid: null, mediaFileId: 20, queue: null, stemMode: 'original', vocalLevel: 0 })).toBe(false);
    expect(audio.track()?.itemId).toBe(1);
  });

  it('closes without stopping the receiver when its cast output loses it', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs1', 10));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    castOut.stop.mockClear();
    host.lost();
    await vi.waitFor(() => expect(audio.track()).toBeNull());
    expect(castOut.release).toHaveBeenCalled();
  });

  it('queues the next track on its cast output near the end', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs1', 10));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2), track(3)]);
    host.position(85);
    expect(castOut.queueNext).toHaveBeenCalledWith(expect.objectContaining({ itemId: 2 }));
    expect(audio.position()).toBe(85);
  });

  it('follows an advance its cast output reports: cursor, duration, stems back to original', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs1', 10));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2), track(3)]);
    audio.setStemMode('guide');
    host.advanced(track(2), castInfo('cs2', 20, 120) as never);
    expect(audio.track()?.itemId).toBe(2);
    expect(audio.queueIndex()).toBe(1);
    expect(audio.duration()).toBe(120);
    expect(audio.stemMode()).toBe('original');
    expect(castLoad).toHaveBeenCalledTimes(1);
    host.ended();
    await vi.waitFor(() => expect(castLoad).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: 3 }), true, 0, expect.any(Function)));
  });

  it('drops the queued track from its cast output when the queue changes under it', async () => {
    castOut.isConnected.set(true);
    castLoad.mockResolvedValue(castInfo('cs1', 10));
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2), track(3)]);
    castOut.dropNext.mockClear();
    audio.removeFromQueue(1);
    expect(castOut.dropNext).toHaveBeenCalled();
  });

  describe('driven by a party', () => {
    const drive = (audio: AudioPlayerService, drives = true) => {
      const router = vi.fn((c: { type: string }) => c.type === 'drives' && drives);
      partyRouter.set(router as never);
      return router;
    };

    it('opens its track paused, alone in the queue when the programme is not adopted yet', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.openForParty(track(3));
      expect(audio.queue().map((t) => t.itemId)).toEqual([3]);
      expect(audio.track()?.itemId).toBe(3);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it('opens a track where the adopted programme holds it, and adopts a programme under the playing track', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.openForParty(track(2));
      audio.adoptQueue([track(1), track(2), track(3)], 1);
      expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2, 3]);
      expect(audio.queueIndex()).toBe(1);
      expect(audio.track()?.itemId).toBe(2);
      await audio.openForParty(track(3));
      expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2, 3]);
      expect(audio.queueIndex()).toBe(2);
    });

    it('leaves the preload and the native queue alone when the adopted programme is the queue already', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.openForParty(track(2));
      audio.adoptQueue([track(1), track(2)], 1);
      const before = audio.queue();
      audio.adoptQueue([track(1), track(2)], 1);
      expect(audio.queue()).toBe(before);
    });

    it('hands an enqueue to the party and sends a queue edit to it, which holds the programme, and keeps the playing row', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      const router = vi.fn((c: { type: string }) => c.type !== 'external');
      partyRouter.set(router as never);
      audio.enqueueTracks([track(3)], 'last');
      expect(router).toHaveBeenCalledWith({ type: 'enqueue', tracks: [expect.objectContaining({ itemId: 3 })], where: 'last' }, 'audio');
      expect(audio.queue().map((t) => t.itemId)).toEqual([1, 2]);
      audio.removeFromQueue(1);
      expect(router).toHaveBeenCalledWith({ type: 'queue', tracks: [expect.objectContaining({ itemId: 1 })] }, 'audio');
      expect(audio.queue().map((t) => t.itemId)).toEqual([1]);
      audio.removeFromQueue(0);
      expect(audio.queue().map((t) => t.itemId)).toEqual([1]);
      audio.setShuffle(true);
      expect(audio.shuffle()).toBe(false);
    });

    it('turns toggle, seek, next and previous into party commands and leaves the element alone', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      const router = vi.fn((_c: { type: string }) => true);
      partyRouter.set(router as never);
      (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
      audio.toggle();
      await audio.seek(30);
      audio.next();
      audio.previous();
      expect(router.mock.calls.map(([c]) => c.type)).toEqual(['toggle', 'seek', 'next', 'prev']);
      expect(audio.track()?.itemId).toBe(1);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it('seeks the element itself through seekLocal', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      drive(audio);
      await audio.seekLocal(12);
      expect(els(audio)[0].currentTime).toBe(12);
    });

    it('does not advance or preload when a track ends, and reports it ended', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      drive(audio);
      getItemPlaybackInfo.mockClear();
      els(audio)[0].dispatchEvent(new Event('ended'));
      expect(audio.track()?.itemId).toBe(1);
      expect(audio.ended()).toBe(true);
      expect(getItemPlaybackInfo).not.toHaveBeenCalled();
      await audio.seekLocal(0);
      expect(audio.ended()).toBe(false);
    });

    it('refuses an outside play while the party drives it', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      const router = vi.fn((_c: { type: string }) => true);
      partyRouter.set(router as never);
      await audio.playTracks([track(1)]);
      expect(audio.track()).toBeNull();
      expect(router).toHaveBeenCalledWith({ type: 'external' }, 'audio');
    });

    it('ducks the element level without touching the prefs', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      audio.setDuck(0.4);
      expect(els(audio)[0].volume).toBeCloseTo(0.4);
      audio.setDuck(1);
      expect(els(audio)[0].volume).toBe(1);
      expect(localStorage.getItem('fliks.audio.prefs')).toBeNull();
    });

    it('nudges the playback rate without saving it', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      audio.setElementRate(1.05);
      expect(audio.elementRate()).toBe(1.05);
      expect(audio.rate()).toBe(1);
      expect(localStorage.getItem('fliks.audio.prefs')).toBeNull();
    });
  });

  describe('remote control', () => {
    it('publishes its queue on the first beat and again when it changes', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      TestBed.tick();
      const queues = () => updatePlaybackState.mock.calls.map((c) => c[1].queue);
      expect(queues().at(-1)).toEqual({ itemIds: [1, 2], index: 0, shuffle: false, repeat: 'off' });
      expect(updatePlaybackState.mock.calls.at(-1)![1]).toMatchObject({ hasNext: true, playbackRate: 1 });
      updatePlaybackState.mockClear();
      (audio as unknown as { beat(): void }).beat();
      expect(queues()).toEqual([undefined]);
      audio.setRepeat('all');
      TestBed.tick();
      expect(queues().at(-1).repeat).toBe('all');
      audio.setShuffle(true);
      TestBed.tick();
      expect(queues().at(-1).shuffle).toBe(true);
      audio.setRate(1.5);
      TestBed.tick();
      expect(updatePlaybackState.mock.calls.at(-1)![1].playbackRate).toBe(1.5);
    });

    it('applies transport, shuffle and repeat commands and acknowledges them', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2), track(3)]);
      validated.next(cmd('next'));
      await vi.waitFor(() => expect(audio.queueIndex()).toBe(1));
      validated.next(cmd('prev', { cmdId: 'c2' }));
      await vi.waitFor(() => expect(audio.queueIndex()).toBe(0));
      validated.next(cmd('repeat', { repeat: 'one' }));
      validated.next(cmd('shuffle', { shuffle: true }));
      await vi.waitFor(() => expect([audio.repeat(), audio.shuffle()]).toEqual(['one', true]));
      expect(markApplied).toHaveBeenCalledWith('c2');
    });

    it('applies a karaoke command and reports the mix, the key and the stems', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      validated.next(cmd('karaoke', { stemMode: 'guide', level: 0.4 }));
      await vi.waitFor(() => expect([audio.stemMode(), audio.vocalLevel()]).toEqual(['guide', 0.4]));
      expect(markApplied).toHaveBeenCalledWith('c1');
      await vi.waitFor(() => expect(updatePlaybackState.mock.calls.at(-1)![1]).toMatchObject({ stemMode: 'guide', vocalLevel: 0.4, pitch: 0, stemsAvailable: false }));
    });

    it('never reports the next queue index against the track a remote skip is leaving', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2), track(3)]);
      TestBed.tick();
      updatePlaybackState.mockClear();
      validated.next(cmd('next'));
      await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
      TestBed.tick();
      await vi.waitFor(() => expect(updatePlaybackState.mock.calls.some((c) => c[1].itemId === 2)).toBe(true));
      const mismatched = updatePlaybackState.mock.calls.filter((c) => c[1].queue && c[1].queue.itemIds[c[1].queue.index] !== c[1].itemId);
      expect(mismatched).toEqual([]);
    });

    it('enqueues the tracks of an enqueue command and acknowledges it', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      validated.next(cmd('enqueue', { itemIds: [3, 4], where: 'next' }));
      await vi.waitFor(() => expect(markApplied).toHaveBeenCalledWith('c1'));
      expect(audio.queue().map((t) => t.itemId)).toEqual([1, 3, 4, 2]);
      expect(audio.queueIndex()).toBe(0);
    });

    it('beats with the ack when a repeat or shuffle command changes nothing', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      TestBed.tick();
      updatePlaybackState.mockClear();
      validated.next(cmd('repeat', { repeat: 'off' }));
      await vi.waitFor(() => expect(markApplied).toHaveBeenCalledWith('c1'));
      expect(updatePlaybackState).toHaveBeenCalledTimes(1);
      validated.next(cmd('shuffle', { shuffle: false, cmdId: 'c2' }));
      await vi.waitFor(() => expect(markApplied).toHaveBeenCalledWith('c2'));
      expect(updatePlaybackState).toHaveBeenCalledTimes(2);
    });

    it('never beats the new queue index against the track that is still loaded', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      TestBed.tick();
      updatePlaybackState.mockClear();
      audio.next();
      TestBed.tick();
      const stale = updatePlaybackState.mock.calls.filter((c) => c[1].itemId === 1 && c[1].queue?.index === 1);
      expect(stale).toEqual([]);
    });

    it('reports the rate it plays at, 1 while casting', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      audio.setRate(1.5);
      castOut.active.set(true);
      updatePlaybackState.mockClear();
      (audio as unknown as { beat(): void }).beat();
      expect(updatePlaybackState.mock.calls.at(-1)![1].playbackRate).toBe(1);
    });

    it('beats once on a pause, from the element event that carries the new state', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      els(audio)[0].dispatchEvent(new Event('play'));
      updatePlaybackState.mockClear();
      validated.next(cmd('pause'));
      await vi.waitFor(() => expect(markApplied).toHaveBeenCalledWith('c1'));
      expect(updatePlaybackState).not.toHaveBeenCalled();
      els(audio)[0].dispatchEvent(new Event('pause'));
      TestBed.tick();
      expect(updatePlaybackState).toHaveBeenCalledTimes(1);
      expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ state: 'paused' }));
    });

    it('beats at once on a pause that changes nothing, so the controller still gets its ack', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      updatePlaybackState.mockClear();
      validated.next(cmd('pause'));
      await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenCalledTimes(1));
    });

    it('sends a play to the device plays go to, in the shuffled order, and starts nothing here', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      playTarget = 'tv#1';
      await audio.playTracks([track(1), track(2), track(3)], 1, { shuffle: true });
      expect(send).toHaveBeenCalledWith('tv#1', expect.objectContaining({
        action: 'load', kind: 'album', itemId: 2, shuffle: true, queue: expect.objectContaining({ index: 0 }),
      }));
      expect(send.mock.calls[0][1].queue?.itemIds.slice().sort()).toEqual([1, 2, 3]);
      expect(getItemPlaybackInfo).not.toHaveBeenCalled();
      expect(audio.active()).toBe(false);
    });

    it('ignores commands while nothing plays', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      validated.next(cmd('next'));
      await Promise.resolve();
      expect(markApplied).not.toHaveBeenCalled();
      expect(audio.active()).toBe(false);
    });

    it('stops on a stop command and sets the level on volume and mute', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1)]);
      validated.next(cmd('volume', { level: 0.4 }));
      await vi.waitFor(() => expect(els(audio)[0].volume).toBeCloseTo(0.4));
      validated.next(cmd('mute', { muted: true }));
      await vi.waitFor(() => expect(els(audio)[0].volume).toBe(0));
      validated.next(cmd('stop'));
      await vi.waitFor(() => expect(audio.active()).toBe(false));
    });

    it('loads a queue at its position, paused, through the audio loader', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await loaders['audio'](
        cmd('load', { kind: 'album', itemId: 2, queue: { itemIds: [1, 2, 3], index: 1 }, shuffle: true, repeat: 'all', positionSeconds: 75, paused: true }),
      );
      expect(getItemPlaybackInfo).toHaveBeenCalledWith(2, {}, { startAt: 75 });
      expect([audio.queueIndex(), audio.shuffle(), audio.repeat(), audio.queue().length]).toEqual([1, true, 'all', 3]);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it('keeps beating a paused load sent here, which reports no play state', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        await loaders['audio'](cmd('load', { kind: 'album', itemId: 2, queue: { itemIds: [1, 2, 3], index: 1 }, positionSeconds: 75, paused: true }));
        TestBed.tick();
        updatePlaybackState.mockClear();
        vi.advanceTimersByTime(15_000);
        expect(updatePlaybackState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ itemId: 2, state: 'paused' }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('replaces the queue under the running track without restarting it', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      getItemPlaybackInfo.mockClear();
      validated.next(cmd('queue', { queue: { itemIds: [3, 1, 4], index: 1 } }));
      await vi.waitFor(() => expect(audio.queue().map((t) => t.itemId)).toEqual([3, 1, 4]));
      expect(audio.queueIndex()).toBe(1);
      expect(getItemPlaybackInfo).not.toHaveBeenCalled();
    });
  });
});
