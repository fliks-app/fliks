import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { MediaService } from '../api/media.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { ServerConfigService } from '../server-config.service';
import { StorageScopeService } from '../storage-scope.service';
import { CastService } from '../cast.service';
import { CastPlayerService } from '../cast-player.service';
import { AudioPlayerService } from './audio-player.service';
import type { MusicTrackRequest } from './music-queue';

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

describe('AudioPlayerService music mode', () => {
  const getItemPlaybackInfo = vi.fn();
  const updatePlaybackState = vi.fn();
  const stopSession = vi.fn();
  const castTrack = vi.fn();
  const cast = {
    isConnected: signal(false),
    currentTime: signal(0),
    isPaused: signal(true),
    ended: signal(false),
    togglePlayPause: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
  };
  const els = (a: AudioPlayerService) => (a as unknown as { els: HTMLAudioElement[] }).els;

  beforeEach(() => {
    localStorage.clear();
    cast.isConnected.set(false);
    castTrack.mockReset();
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
        provideZonelessChangeDetection(),
        {
          provide: StreamingApiService,
          useValue: {
            getItemPlaybackInfo,
            updatePlaybackState,
            stopSession,
            buildPlayUrl: (pi: { playUrl: string }) => pi.playUrl,
            positionRequest: () => ({ url: '/x', init: {} }),
          },
        },
        { provide: CastService, useValue: cast },
        { provide: CastPlayerService, useValue: { castTrack } },
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
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, mediaFileId: 10, sessionId: 'sid1' }));
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

  it('preloads the next track near the end and starts it on the standby element at ended', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1), track(2)]);
    const [a, b] = els(audio);
    a.currentTime = 90;
    a.dispatchEvent(new Event('timeupdate'));
    await vi.waitFor(() => expect(b.getAttribute('src')).toBe('/s/2'));
    a.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(audio.track()?.itemId).toBe(2));
    expect(getItemPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledWith('sid1');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
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

  it('plays a track on the receiver when connected, and keeps the server session for the heartbeat', async () => {
    cast.isConnected.set(true);
    castTrack.mockResolvedValue({ sessionId: 'cs', mediaFileId: 77, durationSeconds: 100, playMethod: 'DirectPlay' });
    const audio = TestBed.inject(AudioPlayerService);
    await audio.playTracks([track(1)]);
    expect(castTrack).toHaveBeenCalledWith(expect.objectContaining({ itemId: 1 }));
    expect(getItemPlaybackInfo).not.toHaveBeenCalled();
    expect(audio.playing()).toBe(true);
    audio.toggle();
    expect(cast.togglePlayPause).toHaveBeenCalled();
    await audio.seek(30);
    expect(cast.seek).toHaveBeenCalledWith(30);
    expect(updatePlaybackState).toHaveBeenLastCalledWith(1, expect.objectContaining({ itemId: 1, mediaFileId: 77, sessionId: 'cs', positionSeconds: 30 }));
    await audio.close();
    expect(cast.stop).toHaveBeenCalled();
  });

  describe('driven by a party', () => {
    const drive = (audio: AudioPlayerService, drives = true) => {
      const router = vi.fn((c: { type: string }) => c.type === 'drives' && drives);
      audio.setPartyRouter(router as never);
      return router;
    };

    it('opens its track paused, with a queue of just that track', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.openForParty(track(3));
      expect(audio.queue().map((t) => t.itemId)).toEqual([3]);
      expect(audio.track()?.itemId).toBe(3);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it('turns toggle, seek, next and previous into party commands and leaves the element alone', async () => {
      const audio = TestBed.inject(AudioPlayerService);
      await audio.playTracks([track(1), track(2)]);
      const router = vi.fn((_c: { type: string }) => true);
      audio.setPartyRouter(router);
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
      audio.setPartyRouter(router);
      await audio.playTracks([track(1)]);
      expect(audio.track()).toBeNull();
      expect(router).toHaveBeenCalledWith({ type: 'external' });
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
});
