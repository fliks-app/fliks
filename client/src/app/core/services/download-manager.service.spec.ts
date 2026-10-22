import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManagerService, pickRung } from './download-manager.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService } from './api/media.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { AppSettingsService } from './app-settings.service';
import { DownloadSettingsService } from './download-settings.service';
import { ImageCacheService } from './image-cache.service';
import { ServerConfigService } from './server-config.service';
import { NetworkService } from './network.service';

const source = { width: 1920, height: 1080, crop: { x: 0, y: 140, width: 1920, height: 800 } };

async function download(pi: object): Promise<DownloadTask> {
  let saved: DownloadTask[] = [];
  TestBed.configureTestingModule({
    providers: [
      DownloadManagerService,
      {
        provide: StreamingApiService,
        useValue: { getPlaybackInfo: () => Promise.resolve(pi), resolveDownloadUrl: () => 'https://x/master.m3u8' },
      },
      { provide: SubtitlesApiService, useValue: {} },
      { provide: MediaService, useValue: {} },
      { provide: OfflineStorageService, useValue: {} },
      { provide: DownloadCacheService, useValue: { load: () => saved, save: (t: DownloadTask[]) => (saved = t) } },
      { provide: DownloadNotificationService, useValue: { nativeEvent: signal(null), startDownload: vi.fn() } },
      { provide: AuthService, useValue: { ensureStreamToken: () => Promise.resolve(), streamToken: () => 't' } },
      { provide: BrowserDeviceProfileService, useValue: { getProfile: () => ({}) } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: AppSettingsService, useValue: {} },
      { provide: ImageCacheService, useValue: {} },
      { provide: DownloadSettingsService, useValue: {} },
      { provide: ServerConfigService, useValue: { isNative: false } },
      { provide: NetworkService, useValue: { isOnline: () => false } },
    ],
  });
  const service = TestBed.inject(DownloadManagerService);
  vi.spyOn(service as any, 'enqueueWeb').mockImplementation(() => {});
  await service.createDownload(1, '1080p', 'Title');
  return saved[0];
}

describe('DownloadManagerService, offline crop metadata', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('persists the rectangle and source size for a copy stream', async () => {
    const task = await download({ videoCopyStream: true, source });
    expect(task.offlineCrop).toEqual({
      x: 0, y: 140, width: 1920, height: 800, sourceWidth: 1920, sourceHeight: 1080,
    });
  });

  it('persists nothing for a re-encode, the server already cropped it', async () => {
    const task = await download({ videoCopyStream: false, source });
    expect(task.offlineCrop).toBeUndefined();
  });
});

describe('DownloadManagerService, offline subtitle identity', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('records each subtitle\'s online id and descriptors, so offline playback ranks and labels it like online', async () => {
    let saved = [{ id: 5, mediaId: 1, mediaFileId: 9 }] as unknown as DownloadTask[];
    const rows = [
      { id: 40, mediaFileId: 9, language: 'en', relativePath: 'a.srt', streamIndex: null, codec: 'subrip' },
      { id: 41, mediaFileId: 9, language: 'en', relativePath: null, streamIndex: 3, codec: 'subrip', forced: true },
    ];
    TestBed.configureTestingModule({
      providers: [
        DownloadManagerService,
        {
          provide: StreamingApiService,
          useValue: { getEmbeddedSubtitleUrl: () => 'emb', getSubtitleUrl: () => 'ext' },
        },
        { provide: SubtitlesApiService, useValue: { getForMedia: () => Promise.resolve(rows) } },
        { provide: MediaService, useValue: { getOne: () => Promise.resolve({ files: [] }) } },
        { provide: OfflineStorageService, useValue: { downloadSmallFile: () => Promise.resolve(true) } },
        { provide: DownloadCacheService, useValue: { load: () => saved, save: (t: DownloadTask[]) => (saved = t) } },
        { provide: DownloadNotificationService, useValue: { nativeEvent: signal(null) } },
        { provide: AuthService, useValue: {} },
        { provide: BrowserDeviceProfileService, useValue: {} },
        { provide: TranslateService, useValue: { instant: (k: string) => k, currentLang: () => 'en', fallbackLang: () => 'en' } },
        { provide: AppSettingsService, useValue: { showSubtitleFormat: () => false } },
        { provide: ImageCacheService, useValue: { prefetch: () => Promise.resolve() } },
        { provide: DownloadSettingsService, useValue: {} },
        { provide: ServerConfigService, useValue: { isNative: false } },
        { provide: NetworkService, useValue: { isOnline: () => false } },
      ],
    });

    await (TestBed.inject(DownloadManagerService) as any).preDownloadSubtitles(5);

    expect(saved[0].offlineSubtitles?.map((s) => s.trackKey)).toEqual(['ext-40', 'emb-3']);
    expect(saved[0].offlineSubtitles?.[1]).toMatchObject({ forced: true, hearingImpaired: false, codec: 'subrip' });
  });
});

describe('DownloadManagerService.createMany', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(onDevice: DownloadTask[], offered: Record<number, string[]>) {
    TestBed.configureTestingModule({
      providers: [
        DownloadManagerService,
        {
          provide: StreamingApiService,
          useValue: {
            getDownloadQualities: (id: number) =>
              Promise.resolve(offered[id].map((key) => ({ key, label: key, estimatedSize: 1 }))),
          },
        },
        { provide: SubtitlesApiService, useValue: {} },
        { provide: MediaService, useValue: {} },
        { provide: OfflineStorageService, useValue: {} },
        { provide: DownloadCacheService, useValue: { load: () => onDevice } },
        { provide: DownloadNotificationService, useValue: { nativeEvent: signal(null) } },
        { provide: AuthService, useValue: {} },
        { provide: BrowserDeviceProfileService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: ImageCacheService, useValue: {} },
        { provide: DownloadSettingsService, useValue: {} },
        { provide: ServerConfigService, useValue: { isNative: false } },
        { provide: NetworkService, useValue: { isOnline: () => false } },
      ],
    });
    const service = TestBed.inject(DownloadManagerService);
    const create = vi.spyOn(service, 'createDownload').mockResolvedValue({} as DownloadTask);
    return { service, create };
  }

  const target = (mediaFileId: number) => ({ mediaId: 1, mediaFileId, title: 'T', posterUrl: null, type: 'series' });

  it('skips files already on device and falls back to the nearest lower rung', async () => {
    const { service, create } = setup(
      [{ mediaFileId: 1, status: 'ready' } as DownloadTask, { mediaFileId: 4, status: 'failed' } as DownloadTask],
      { 2: ['1080p', '720p'], 3: ['720p', '480p'], 4: ['1080p'] },
    );
    const res = await service.createMany([target(1), target(2), target(3), target(4)], '1080p');
    expect(create.mock.calls.map((c) => [c[0], c[1]])).toEqual([[2, '1080p'], [3, '720p'], [4, '1080p']]);
    expect(res).toEqual({ started: 3, failed: 0 });
  });

  it('counts a failing target and keeps going', async () => {
    const { service, create } = setup([], { 1: ['720p'], 2: ['720p'] });
    create.mockRejectedValueOnce(new Error('x'));
    const res = await service.createMany([target(1), target(2)], '720p');
    expect(res).toEqual({ started: 1, failed: 1 });
  });

  it('stops before the next target once stop() turns true', async () => {
    const { service, create } = setup([], { 1: ['720p'], 2: ['720p'] });
    const res = await service.createMany([target(1), target(2)], '720p', { stop: () => create.mock.calls.length > 0 });
    expect(res).toEqual({ started: 1, failed: 0 });
  });
});

describe('pickRung', () => {
  const q = (...keys: string[]) => keys.map((key) => ({ key }));

  it('prefers the exact rung, then the best below, then the lowest on offer', () => {
    expect(pickRung(q('1080p', '720p'), '720p')?.key).toBe('720p');
    expect(pickRung(q('720p', '480p'), '1080p')?.key).toBe('720p');
    expect(pickRung(q('720p', '480p'), '360p')?.key).toBe('480p');
    expect(pickRung(q('original', '720p'), '1080p')?.key).toBe('720p');
  });
});
