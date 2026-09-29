import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManagerService } from './download-manager.service';
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
