import { Capacitor } from '@capacitor/core';
import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicTrackRequest } from './audio-player/music-queue';
import { DownloadManagerService, type BookDownloadTarget } from './download-manager.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService } from './api/media.service';
import { OfflineStorageService } from './offline-storage.service';
import { OfflineBookStoreService } from './offline-book-store.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { AppSettingsService } from './app-settings.service';
import { DownloadSettingsService } from './download-settings.service';
import { ImageCacheService } from './image-cache.service';
import { ServerConfigService } from './server-config.service';
import { NetworkService } from './network.service';

const text: BookDownloadTarget = {
  mediaId: 3, itemId: 30, family: 'text', format: 'epub', fileIds: [300], title: 'Book', posterUrl: null,
};

function setup(initial: DownloadTask[] = [], opts: { wifiOnly?: boolean; connection?: string } = {}) {
  let saved = initial;
  const books = {
    storeEpub: vi.fn(async (..._a: unknown[]) => 1234),
    storeFile: vi.fn(async (..._a: unknown[]) => 50),
    remove: vi.fn(async (..._a: unknown[]) => undefined),
    has: vi.fn(async (..._a: unknown[]) => true),
  };
  const streaming = {
    getOriginalDownloadUrl: (id: number) => `/api/stream/${id}?download=1`,
    buildPlayUrl: ({ playUrl }: { playUrl: string }) => `${playUrl}?token=t`,
    getItemPlaybackInfo: vi.fn(async () => ({
      mediaFileId: 400, playMethod: 'DirectPlay', playUrl: '/api/stream/400/parts/0', durationSeconds: 30, sessionId: 'sid', chapters: [{ startSeconds: 0, endSeconds: 30 }],
      parts: [
        { index: 0, playUrl: '/api/stream/400/parts/0', offsetS: 0, durationS: 10 },
        { index: 1, playUrl: '/api/stream/400/parts/1', offsetS: 10, durationS: 20 },
      ],
    })),
    stopSession: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      DownloadManagerService,
      { provide: StreamingApiService, useValue: streaming },
      { provide: SubtitlesApiService, useValue: {} },
      { provide: MediaService, useValue: {} },
      { provide: OfflineStorageService, useValue: {} },
      { provide: OfflineBookStoreService, useValue: books },
      {
        provide: DownloadCacheService,
        useValue: {
          load: () => saved,
          save: (t: DownloadTask[]) => (saved = t),
          remove: (id: number) => (saved = saved.filter((t) => t.id !== id)),
        },
      },
      { provide: DownloadNotificationService, useValue: { nativeEvents: new Subject(), setNotificationCopy: vi.fn(), dismissActivity: vi.fn(), removeDownload: vi.fn() } },
      { provide: AuthService, useValue: { ensureStreamToken: () => Promise.resolve(), sessionEpoch: () => 0, isAuthenticated: () => false } },
      { provide: BrowserDeviceProfileService, useValue: { getProfile: () => ({}) } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: AppSettingsService, useValue: {} },
      { provide: ImageCacheService, useValue: { prefetch: () => Promise.resolve() } },
      { provide: DownloadSettingsService, useValue: { maxConcurrent: () => 3, wifiOnly: () => !!opts.wifiOnly } },
      { provide: ServerConfigService, useValue: { isNative: false, resolveUrl: (u: string) => u } },
      { provide: NetworkService, useValue: { isOnline: () => true, connectionType: () => opts.connection ?? 'unknown' } },
    ],
  });
  const service = TestBed.inject(DownloadManagerService);
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));
  return { service, books, streaming, saved: () => saved, settled };
}

const track = (itemId: number): MusicTrackRequest => ({
  itemId, mediaId: 7, title: `T${itemId}`, artists: 'A', albumTitle: 'Album', coverUrl: '/c.jpg', durationSeconds: 200, gain: null, peak: null, albumGain: null, albumPeak: null,
});

describe('DownloadManagerService, book downloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('keeps an EPUB publication and marks the task ready with its size', async () => {
    const { service, books, saved, settled } = setup();
    await service.createBookDownload(text);
    await settled();
    expect(books.storeEpub).toHaveBeenCalledWith(30, expect.any(Function), expect.any(AbortSignal));
    expect(saved()[0]).toMatchObject({ status: 'ready', progress: 100, sizeBytes: 1234, mediaFileId: 300, quality: 'epub', media: { type: 'book' } });
    expect(saved().some((t) => t.book?.itemId === 30)).toBe(true);
  });

  it('stores each audio part under its own key and records the timeline', async () => {
    const { service, books, streaming, saved, settled } = setup();
    await service.createBookDownload({ ...text, itemId: 40, family: 'audio', format: 'm4b', fileIds: [400, 401] });
    await settled();
    expect(streaming.stopSession).toHaveBeenCalledWith('sid');
    expect(books.storeFile.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [`${saved()[0].id}-40-0`, '/api/stream/400/parts/0?token=t'],
      [`${saved()[0].id}-40-1`, '/api/stream/400/parts/1?token=t'],
    ]);
    expect(saved()[0].book).toMatchObject({
      durationSeconds: 30,
      files: [{ key: `${saved()[0].id}-40-0`, offsetS: 0, durationS: 10 }, { key: `${saved()[0].id}-40-1`, offsetS: 10, durationS: 20 }],
    });
    expect(saved()[0]).toMatchObject({ status: 'ready', sizeBytes: 100, mediaFileId: 400 });
  });

  it('keeps the original file of each track under one album and skips the ones already there', async () => {
    const { service, books, streaming, saved, settled } = setup();
    const first = await service.createTracks([track(1), track(2)]);
    await settled();
    const again = await service.createTracks([track(2), track(3)]);
    await settled();
    expect(first).toEqual({ started: 2, failed: 0, skipped: 0 });
    expect(again).toEqual({ started: 1, failed: 0, skipped: 1 });
    expect(streaming.stopSession).toHaveBeenCalledTimes(3);
    expect(books.storeFile.mock.calls[0][2]).toBe('/api/stream/400?download=1');
    expect(saved().map((t) => t.book?.itemId)).toEqual([1, 2, 3]);
    expect(saved()[0]).toMatchObject({
      status: 'ready', mediaId: 7, mediaFileId: 400, quality: 'original', episodeLabel: 'T1',
      media: { type: 'album', title: 'Album' },
      book: { family: 'audio', track: { itemId: 1 }, files: [{ offsetS: 0, durationS: 30 }] },
    });
  });

  it('replaces a failed track download instead of stacking a second one', async () => {
    const { service, saved, settled } = setup();
    await service.createTracks([track(1)]);
    await settled();
    saved()[0].status = 'failed';
    await service.createTracks([track(1)]);
    await settled();
    expect(saved()).toHaveLength(1);
    expect(saved()[0].status).toBe('ready');
  });

  it('flags a failed transfer and drops what was stored', async () => {
    const { service, books, saved, settled } = setup();
    books.storeEpub.mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await service.createBookDownload(text);
    await settled();
    expect(saved()[0].status).toBe('failed');
    expect(books.remove).toHaveBeenCalled();
  });

  it('on start-up, flags an interrupted manual download and refetches an interrupted auto one', async () => {
    const task = (id: number, auto: boolean): DownloadTask => ({
      id, mediaId: 3, mediaFileId: 300, quality: 'epub', status: 'downloading', progress: 40, createdAt: '', auto,
      book: { itemId: 30 + id, family: 'text' as const, format: 'epub', files: [{ key: '300', offsetS: 0, durationS: 0 }] },
    });
    const { service, saved, books } = setup([task(1, false), task(2, true)]);
    await (service as unknown as { recover(s: boolean): Promise<void> }).recover(true);
    expect(saved().map((t) => [t.id, t.status])).toEqual([[1, 'failed']]);
    expect(books.remove).toHaveBeenCalledTimes(2);
  });

  it('drops a ready download whose files are gone', async () => {
    const book = { itemId: 30, family: 'text' as const, format: 'epub', files: [{ key: '300', offsetS: 0, durationS: 0 }] };
    const { service, saved, books } = setup([
      { id: 1, mediaId: 3, mediaFileId: 300, quality: 'epub', status: 'ready', progress: 100, createdAt: '', book },
    ]);
    books.has.mockResolvedValueOnce(false);
    await (service as unknown as { recover(): Promise<void> }).recover();
    expect(saved()).toEqual([]);
  });

  it('refuses an audiobook the device would not play as is', async () => {
    const { service, streaming, saved } = setup();
    streaming.getItemPlaybackInfo.mockResolvedValueOnce({ playMethod: 'Transcode' } as never);
    await expect(service.createBookDownload({ ...text, family: 'audio', format: 'm4b' })).rejects.toThrow('books_work.offline_audio_unplayable');
    expect(saved()).toEqual([]);
  });

  it('refuses a book on a cellular link when downloads are Wi-Fi only', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const { service, saved } = setup([], { wifiOnly: true, connection: 'cellular' });
    await expect(service.createBookDownload(text)).rejects.toThrow('books_work.offline_wifi_only');
    expect(saved()).toEqual([]);
  });

  it('deleting a running download aborts it and leaves nothing stored', async () => {
    const { service, books, saved, settled } = setup();
    books.storeEpub.mockImplementationOnce((...a: unknown[]) => new Promise<number>((_, reject) => (a[2] as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')))));
    const task = await service.createBookDownload(text);
    await settled();
    await service.deleteDownload(task);
    await settled();
    expect(saved()).toEqual([]);
    expect(books.remove).toHaveBeenCalledTimes(2);
  });

  it('a deleted run that ends late never removes the files of a newer task for the same item', async () => {
    const { service, books, saved, settled } = setup();
    const audio = { ...text, itemId: 40, family: 'audio' as const, format: 'm4b', fileIds: [400] };
    let late!: () => void;
    books.storeFile.mockImplementationOnce(() => new Promise<number>((_, reject) => (late = () => reject(new Error('ended')))));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await service.createBookDownload(audio);
    await settled();
    await service.deleteDownload(first);
    const second = await service.createBookDownload(audio);
    await settled();
    books.remove.mockClear();
    late();
    await settled();
    const removed = books.remove.mock.calls.flatMap((c) => (c[0] as { files: { key: string }[] }).files.map((f) => f.key));
    expect(removed.every((k) => k.startsWith(`${first.id}-`))).toBe(true);
    expect(removed.length).toBeGreaterThan(0);
    expect(saved().find((t) => t.id === second.id)?.book?.files[0].key).toBe(`${second.id}-40-0`);
  });

  it('deleting a failed task keeps the EPUB a ready task of the same item still uses', async () => {
    const { service, books, settled } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    books.storeEpub.mockRejectedValueOnce(new Error('network'));
    const failed = await service.createBookDownload(text);
    await settled();
    await service.createBookDownload(text);
    await settled();
    books.remove.mockClear();
    await service.deleteDownload(failed);
    expect(books.remove).not.toHaveBeenCalled();
  });
});
