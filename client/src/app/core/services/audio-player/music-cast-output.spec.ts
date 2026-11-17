import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingApiService } from '../api/streaming-api.service';
import { AuthService } from '../auth.service';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { NowPlayingMetadataService } from '../playback/now-playing-metadata.service';
import { ServerConfigService } from '../server-config.service';
import { ServerVersionService } from '../server-version.service';
import { ToastService } from '../toast.service';
import { MusicCastOutput, type MusicCastHost, type MusicCastState } from './music-cast-output';
import type { MusicTrackRequest } from './music-queue';

const track = (id: number): MusicTrackRequest => ({
  itemId: id,
  mediaId: 3,
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

const info = (sessionId: string, mediaFileId: number, durationSeconds = 100) => ({ sessionId, mediaFileId, durationSeconds, playMethod: 'DirectPlay' });

describe('MusicCastOutput', () => {
  let layeredServer = true;
  let current: MusicTrackRequest | null = track(1);
  let queue: { itemIds: number[]; index: number; shuffle: boolean; repeat: 'off' } | null = null;
  let karaoke = { mode: 'original' as string, level: 0 };
  const cast = {
    isConnected: signal(true),
    currentTime: signal(0),
    isPaused: signal(true),
    buffering: signal(false),
    ended: signal(false),
    receiverMedia: signal<Record<string, unknown> | null>(null),
    queueNext: vi.fn(),
    loadMedia: vi.fn(async (..._a: unknown[]) => {}),
    setMix: vi.fn(async (..._a: unknown[]) => {}),
    setCastStreamBase: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    saveResumeState: vi.fn(),
    clearResumeState: vi.fn(),
  };
  const getItemPlaybackInfo = vi.fn();
  const stopSession = vi.fn(async () => {});
  const host = {
    current: () => current,
    karaoke: () => karaoke,
    playhead: () => ({ position: 30, playing: true }),
    position: vi.fn(),
    playState: vi.fn(),
    buffering: vi.fn(),
    ended: vi.fn(),
    advanced: vi.fn(),
    reloaded: vi.fn(),
    stemsFailed: vi.fn(),
    startOnCast: vi.fn(async () => {}),
    queue: () => queue,
    adopt: vi.fn(async (..._a: unknown[]) => true),
    adopted: vi.fn(),
    lost: vi.fn(),
  };
  const stems = (vocals: number) => [
    { url: 'http://srv/api/media-files/77/stems/instrumental/pcm?token=st', gain: 1 },
    { url: 'http://srv/api/media-files/77/stems/vocals/pcm?token=st', gain: vocals },
  ];
  const STEMS = { guide: 'audio/ogg', instrumental: 'audio/mpeg' };

  const start = async (out: MusicCastOutput) => {
    out.attach(host as MusicCastHost);
    await out.load(track(1), true, 0, () => true);
  };

  beforeEach(() => {
    layeredServer = true;
    current = track(1);
    karaoke = { mode: 'original', level: 0 };
    queue = { itemIds: [1, 2], index: 0, shuffle: false, repeat: 'off' };
    host.adopt.mockImplementation(async () => true);
    cast.isConnected.set(true);
    cast.currentTime.set(0);
    cast.isPaused.set(true);
    cast.ended.set(false);
    cast.receiverMedia.set(null);
    for (const f of [cast.queueNext, cast.loadMedia, cast.setMix, cast.stop, cast.saveResumeState, cast.clearResumeState, ...Object.values(host)]) (f as ReturnType<typeof vi.fn>).mockClear?.();
    getItemPlaybackInfo.mockReset();
    getItemPlaybackInfo.mockImplementation(async (itemId: number) => info(`s${itemId}`, itemId * 10));
    stopSession.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: CastService, useValue: cast },
        { provide: CastPlayerService, useValue: { getCastDeviceProfile: () => ({}) } },
        { provide: StreamingApiService, useValue: { getItemPlaybackInfo, stopSession, absoluteUrl: (p: string) => `http://srv${p}`, buildAbsolutePlayUrl: (pi: { sessionId: string }) => ({ url: `/c/${pi.sessionId}`, contentType: 'audio/flac' }) } },
        { provide: AuthService, useValue: { ensureStreamToken: async () => 'st', getCastInfo: async () => ({ token: 't', streamBaseUrl: 'b' }), user: () => ({ id: 1 }) } },
        { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
        { provide: ServerVersionService, useValue: { supports: () => layeredServer } },
        { provide: NowPlayingMetadataService, useValue: { primeTracks: vi.fn() } },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        { provide: ToastService, useValue: { error: vi.fn() } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('declares the mix of the PCM stems before the LOAD that plays it', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.setStemSource(77, STEMS);
    karaoke = { mode: 'guide', level: 0.25 };
    await out.applyStems();
    expect(cast.setMix).toHaveBeenCalledWith('karaoke-77', stems(0.25));
    expect(cast.setMix.mock.invocationCallOrder[0]).toBeLessThan(cast.loadMedia.mock.invocationCallOrder[1]);
    expect(cast.loadMedia).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'fliks-mix:karaoke-77', contentType: 'audio/mp4', itemId: 1, stem: 'mix', currentTime: 30 }));
  });

  it('moves the vocal level with the mix alone, no LOAD, and reloads the track on original', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.setStemSource(77, STEMS);
    karaoke = { mode: 'guide', level: 0.4 };
    await out.applyStems();
    cast.loadMedia.mockClear();
    karaoke = { mode: 'guide', level: 0.6 };
    await out.applyStems();
    expect(cast.setMix).toHaveBeenLastCalledWith('karaoke-77', stems(0.6));
    expect(cast.loadMedia).not.toHaveBeenCalled();
    karaoke = { mode: 'original', level: 0 };
    await out.applyStems();
    expect(cast.loadMedia).toHaveBeenCalledWith(expect.objectContaining({ url: '/c/s1', currentTime: 30, autoplay: true }));
    expect(host.reloaded).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('loads the guide stem alone on a server without stem PCM', async () => {
    layeredServer = false;
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.setStemSource(77, STEMS);
    karaoke = { mode: 'guide', level: 0.4 };
    await out.applyStems();
    expect(cast.setMix).not.toHaveBeenCalled();
    expect(cast.loadMedia).toHaveBeenLastCalledWith(expect.objectContaining({ contentType: 'audio/ogg', stem: 'guide', mediaFileId: 77 }));
  });

  it('drops a stem switch that was overtaken by a stop', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.setStemSource(77, STEMS);
    karaoke = { mode: 'guide', level: 0.4 };
    cast.setMix.mockImplementationOnce(async () => out.stop());
    await out.applyStems();
    expect(cast.loadMedia).toHaveBeenCalledTimes(1);
    expect(host.stemsFailed).not.toHaveBeenCalled();
  });

  it('queues the next track on the receiver, then reports the advance once and ends only after play', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.queueNext(track(2));
    await vi.waitFor(() => expect(cast.queueNext).toHaveBeenCalledWith(expect.objectContaining({ url: '/c/s2' })));
    expect(out.hasNext()).toBe(true);
    // CAF reports the move as the queued track IDLE and finished, then under way.
    cast.receiverMedia.set({ itemId: 2, sid: 's2' });
    cast.ended.set(true);
    TestBed.tick();
    expect(host.advanced).toHaveBeenCalledTimes(1);
    expect(host.advanced).toHaveBeenCalledWith(track(2), expect.objectContaining({ sessionId: 's2' }));
    expect(host.ended).not.toHaveBeenCalled();
    expect(out.hasNext()).toBe(false);
  });

  it('drops the queued track from the receiver and stops its session', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    out.queueNext(track(2));
    await vi.waitFor(() => expect(out.hasNext()).toBe(true));
    out.dropNext();
    expect(cast.queueNext).toHaveBeenLastCalledWith(null);
    expect(stopSession).toHaveBeenCalledWith('s2');
    expect(out.hasNext()).toBe(false);
  });

  it('ignores an end the receiver still reports for the previous track', async () => {
    const out = TestBed.inject(MusicCastOutput);
    await start(out);
    cast.receiverMedia.set({ itemId: 7, sid: 'old' });
    cast.ended.set(true);
    TestBed.tick();
    expect(host.ended).not.toHaveBeenCalled();
    cast.receiverMedia.set({ itemId: 1, sid: 's1' });
    cast.ended.set(false);
    TestBed.tick();
    cast.ended.set(true);
    TestBed.tick();
    expect(host.ended).toHaveBeenCalledTimes(1);
  });

  it('feeds the receiver position, play state and buffering to its host while it is active', async () => {
    const out = TestBed.inject(MusicCastOutput);
    out.attach(host as MusicCastHost);
    cast.currentTime.set(12);
    TestBed.tick();
    expect(host.position).not.toHaveBeenCalled();
    await out.load(track(1), true, 0, () => true);
    cast.currentTime.set(13);
    cast.isPaused.set(false);
    TestBed.tick();
    expect(host.position).toHaveBeenLastCalledWith(13);
    expect(host.playState).toHaveBeenLastCalledWith(true);
  });

  it('stops the receiver only when it plays there', async () => {
    const out = TestBed.inject(MusicCastOutput);
    out.attach(host as MusicCastHost);
    out.stop();
    expect(cast.stop).not.toHaveBeenCalled();
    await out.load(track(1), true, 0, () => true);
    expect(out.hasMedia()).toBe(true);
    out.stop();
    expect(cast.stop).toHaveBeenCalledTimes(1);
    expect(out.hasMedia()).toBe(false);
  });

  it('snapshots the receiver position and play state with the queue track', () => {
    const out = TestBed.inject(MusicCastOutput);
    expect(out.snapshot()).toBeNull();
    out.attach(host as MusicCastHost);
    expect(out.snapshot()).toEqual({ track: track(1), position: 30, paused: false });
    current = null;
    expect(out.snapshot()).toBeNull();
  });

  it('starts a music hand-over through its host', async () => {
    const out = TestBed.inject(MusicCastOutput);
    out.attach(host as MusicCastHost);
    const snapshot = { track: track(1), position: 12, paused: true };
    await out.start({ kind: 'music', snapshot });
    expect(host.startOnCast).toHaveBeenCalledWith(snapshot);
  });

  describe('rejoin after a restart', () => {
    const saved: MusicCastState = { mediaId: 3, mediaFileId: 10, itemId: 1, sid: 's1', stem: null, queue: { itemIds: [1, 2], index: 0, shuffle: false, repeat: 'off' }, stemMode: 'original', vocalLevel: 0 };
    const arm = (state = saved) => {
      const out = TestBed.inject(MusicCastOutput);
      out.attach(host as MusicCastHost);
      out.adopt(state);
      return out;
    };

    it('saves a music-tagged resume state with the receiver ids, the queue and the mix', async () => {
      const out = TestBed.inject(MusicCastOutput);
      await start(out);
      TestBed.tick();
      expect(cast.saveResumeState).toHaveBeenLastCalledWith('music', { mediaId: 3, mediaFileId: 10, itemId: 1, sid: 's1', stem: null, queue, stemMode: 'original', vocalLevel: 0 });
      out.setStemSource(77, STEMS);
      karaoke = { mode: 'guide', level: 0.25 };
      await out.applyStems();
      TestBed.tick();
      expect(cast.saveResumeState).toHaveBeenLastCalledWith('music', expect.objectContaining({ mediaFileId: 77, stem: 'mix', stemMode: 'guide', vocalLevel: 0.25, sid: 's1' }));
    });

    it('updates the saved ids when the receiver moves to the queued track', async () => {
      const out = TestBed.inject(MusicCastOutput);
      await start(out);
      out.queueNext(track(2));
      await vi.waitFor(() => expect(out.hasNext()).toBe(true));
      cast.receiverMedia.set({ itemId: 2, sid: 's2' });
      TestBed.tick();
      expect(cast.saveResumeState).toHaveBeenLastCalledWith('music', expect.objectContaining({ itemId: 2, mediaFileId: 20, sid: 's2' }));
    });

    it('clears its own state on stop and release', async () => {
      const out = TestBed.inject(MusicCastOutput);
      await start(out);
      out.stop();
      out.release();
      expect(cast.clearResumeState).toHaveBeenCalledTimes(2);
      expect(cast.clearResumeState).toHaveBeenCalledWith('music');
    });

    it('adopts the receiver music once a resumed state armed it, the queue from the state', async () => {
      const out = arm();
      expect(out.hasMedia()).toBe(true);
      expect(out.active()).toBe(false);
      cast.receiverMedia.set({ itemId: 1, mediaId: 3, mediaFileId: 10, sid: 's1', userId: 1 });
      TestBed.tick();
      await vi.waitFor(() => expect(out.active()).toBe(true));
      expect(host.adopt).toHaveBeenCalledWith({ itemId: 1, sid: 's1', mediaFileId: 10, queue: saved.queue, stemMode: 'original', vocalLevel: 0 });
      expect(host.adopted).toHaveBeenCalled();
      expect(cast.loadMedia).not.toHaveBeenCalled();
    });

    it('aligns on the track the receiver plays when the state is a track behind, dropping its mix', async () => {
      arm({ ...saved, stemMode: 'guide', vocalLevel: 0.3, stem: 'mix' });
      cast.receiverMedia.set({ itemId: 2, mediaId: 3, mediaFileId: 20, sid: 's2', userId: 1 });
      TestBed.tick();
      await vi.waitFor(() => expect(host.adopt).toHaveBeenCalled());
      expect(host.adopt).toHaveBeenCalledWith(expect.objectContaining({ itemId: 2, sid: 's2', stemMode: 'original', vocalLevel: 0 }));
    });

    it('never adopts receiver music without a resumed state, nor another user\'s', () => {
      const out = TestBed.inject(MusicCastOutput);
      out.attach(host as MusicCastHost);
      cast.receiverMedia.set({ itemId: 1, mediaFileId: 10, userId: 1 });
      TestBed.tick();
      arm();
      cast.receiverMedia.set({ itemId: 1, mediaFileId: 10, userId: 9 });
      TestBed.tick();
      expect(host.adopt).not.toHaveBeenCalled();
      expect(out.active()).toBe(false);
    });

    it('stays inactive and disarms when the host refuses the receiver music', async () => {
      host.adopt.mockImplementationOnce(async () => false);
      const out = arm();
      cast.receiverMedia.set({ itemId: 1, mediaFileId: 10, userId: 1 });
      TestBed.tick();
      await vi.waitFor(() => expect(host.adopt).toHaveBeenCalled());
      expect(out.active()).toBe(false);
      expect(out.hasMedia()).toBe(false);
    });

    it('disarms on a disconnect', () => {
      const out = arm();
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(out.hasMedia()).toBe(false);
    });

    it('gives the receiver up when another sender\'s media replaces its own', async () => {
      const out = TestBed.inject(MusicCastOutput);
      await start(out);
      cast.receiverMedia.set({ itemId: 1, sid: 's1' });
      TestBed.tick();
      cast.receiverMedia.set({ mediaFileId: 99, mediaId: 5 });
      TestBed.tick();
      expect(host.lost).toHaveBeenCalledTimes(1);
    });

    it('ignores media without an item id until its own LOAD was reported', async () => {
      const out = TestBed.inject(MusicCastOutput);
      await start(out);
      cast.receiverMedia.set({ mediaFileId: 99, mediaId: 5 });
      TestBed.tick();
      expect(host.lost).not.toHaveBeenCalled();
    });
  });
});
