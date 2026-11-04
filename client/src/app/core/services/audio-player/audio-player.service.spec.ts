import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { MediaService } from '../api/media.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { ServerConfigService } from '../server-config.service';
import { StorageScopeService } from '../storage-scope.service';
import { AudioPlayerService } from './audio-player.service';

const info = {
  playMethod: 'DirectPlay',
  playUrl: '/api/stream/7/parts/0',
  mediaFileId: 7,
  sessionId: 'sid',
  startAtSeconds: 0,
  durationSeconds: 30,
  parts: [
    { index: 0, playUrl: '/api/stream/7/parts/0', offsetS: 0, durationS: 10, contentType: 'audio/mpeg' },
    { index: 1, playUrl: '/api/stream/7/parts/1', offsetS: 10, durationS: 20, contentType: 'audio/mpeg' },
  ],
};

describe('AudioPlayerService', () => {
  const getItemPlaybackInfo = vi.fn();
  const updatePlaybackState = vi.fn();
  const stopSession = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    getItemPlaybackInfo.mockResolvedValue(info);
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
        { provide: BrowserDeviceProfileService, useValue: { getProfile: () => ({}) } },
        { provide: MediaService, useValue: {} },
        { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
        { provide: StorageScopeService, useValue: { suffix: () => 's', canPersist: () => true } },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const req = { mediaId: 1, itemId: 5, title: 'Book' };

  it('opens the item session and lays its parts on one timeline with a chapter per part', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    expect(getItemPlaybackInfo).toHaveBeenCalledWith(5, {});
    expect(audio.duration()).toBe(30);
    expect(audio.chapters().map((c) => c.start)).toEqual([0, 10]);
    expect(audio.track()?.title).toBe('Book');
    expect(audio.loading()).toBe(false);
  });

  it('never pauses an item that is already playing when asked to play it again', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    const el = (audio as unknown as { els: HTMLAudioElement[] }).els[0];
    vi.spyOn(el, 'paused', 'get').mockReturnValue(false);
    (HTMLMediaElement.prototype.pause as unknown as { mockClear(): void }).mockClear?.();
    await audio.play(req);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it('seeks across parts onto the active element and saves the position with the item id', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    await audio.seek(15);
    expect(audio.position()).toBe(15);
    expect((audio as unknown as { partIndex: number }).partIndex).toBe(1);
    expect(updatePlaybackState).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ itemId: 5, mediaFileId: 7, positionSeconds: 15, durationSeconds: 30, sessionId: 'sid' }),
    );
  });

  it('pauses at the end of the chapter when the sleep timer asks for it', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    audio.setSleep('chapter');
    expect(audio.sleep()).toEqual({ kind: 'chapter', end: 10 });
    const el = (audio as unknown as { els: HTMLAudioElement[] }).els[0];
    el.currentTime = 9.9;
    el.dispatchEvent(new Event('timeupdate'));
    expect(audio.sleep()).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('keeps bookmarks per item, in order', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    await audio.seek(20);
    audio.addBookmark();
    await audio.seek(5);
    audio.addBookmark();
    expect(audio.bookmarks().map((b) => b.position)).toEqual([5, 20]);
    audio.removeBookmark(audio.bookmarks()[0]);
    expect(audio.bookmarks().map((b) => b.position)).toEqual([20]);
    await audio.close();
    await audio.play(req);
    expect(audio.bookmarks().map((b) => b.position)).toEqual([20]);
  });

  it('ends the session and clears the player on close', async () => {
    const audio = TestBed.inject(AudioPlayerService);
    await audio.play(req);
    await audio.close();
    expect(stopSession).toHaveBeenCalledWith('sid');
    expect(audio.track()).toBeNull();
  });
});
