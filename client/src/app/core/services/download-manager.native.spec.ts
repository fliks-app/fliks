import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadManagerService } from './download-manager.service';
import { DownloadCacheService, type DownloadTask } from './download-cache.service';
import { DownloadNotificationService, type NativeDownloadEvent } from './download-notification.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService } from './api/media.service';
import { OfflineStorageService } from './offline-storage.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { AppSettingsService } from './app-settings.service';
import { DownloadSettingsService } from './download-settings.service';
import { ImageCacheService } from './image-cache.service';
import { ServerConfigService } from './server-config.service';
import { NetworkService } from './network.service';

const task = (id: number, status: DownloadTask['status'], progress = 0): DownloadTask => ({
  id,
  mediaId: 0,
  mediaFileId: id * 10,
  quality: '1080p',
  status,
  progress,
  createdAt: '',
});

describe('DownloadManagerService native events', () => {
  const events = new Subject<NativeDownloadEvent>();
  const removeDownload = vi.fn(() => Promise.resolve());
  let cache: DownloadCacheService;
  let service: DownloadManagerService;

  beforeEach(() => {
    localStorage.clear();
    removeDownload.mockClear();
    TestBed.configureTestingModule({
      providers: [
        DownloadManagerService,
        { provide: StreamingApiService, useValue: {} },
        { provide: SubtitlesApiService, useValue: {} },
        { provide: MediaService, useValue: {} },
        {
          provide: OfflineStorageService,
          useValue: {
            delete: () => Promise.resolve(),
            deleteSmallFile: () => Promise.resolve(),
            sizeBytes: () => Promise.resolve(null),
            has: () => Promise.resolve(false),
          },
        },
        {
          provide: DownloadNotificationService,
          useValue: {
            nativeEvents: events,
            removeDownload,
            setNotificationCopy: vi.fn(),
            setActivityCopy: vi.fn(),
            dismissActivity: vi.fn(),
            getDownloads: () => Promise.resolve([]),
          },
        },
        {
          provide: AuthService,
          useValue: { user: signal({ id: 1 }), sessionEpoch: () => 0, isAuthenticated: () => false },
        },
        { provide: BrowserDeviceProfileService, useValue: {} },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        { provide: AppSettingsService, useValue: {} },
        { provide: ImageCacheService, useValue: {} },
        { provide: DownloadSettingsService, useValue: {} },
        { provide: ServerConfigService, useValue: { serverUrl: signal('s') } },
        { provide: NetworkService, useValue: { isOnline: () => false } },
      ],
    });
    cache = TestBed.inject(DownloadCacheService);
    service = TestBed.inject(DownloadManagerService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('leaves the task ready in tasks() as soon as a complete event lands', () => {
    cache.save([task(1, 'downloading', 92)]);
    events.next({ type: 'complete', id: '1', progress: 100 });
    expect(service.tasks()[0]).toMatchObject({ status: 'ready', progress: 100 });
  });

  it('puts every progress tick on the signal and keeps the held states', () => {
    cache.save([task(1, 'preparing')]);
    events.next({ type: 'progress', id: '1', progress: 10, state: 'downloading' });
    expect(service.tasks()[0]).toMatchObject({ status: 'downloading', progress: 10 });
    events.next({ type: 'progress', id: '1', progress: 11, state: 'downloading' });
    expect(service.tasks()[0].progress).toBe(11);
    events.next({ type: 'progress', id: '1', progress: 11, state: 'waiting_wifi' });
    expect(service.tasks()[0].status).toBe('waiting_wifi');
  });

  it('ignores a late progress tick once the task is ready', () => {
    cache.save([task(1, 'ready', 100)]);
    events.next({ type: 'progress', id: '1', progress: 95, state: 'downloading' });
    expect(service.tasks()[0]).toMatchObject({ status: 'ready', progress: 100 });
  });

  it('deletes the task on a removed event', async () => {
    cache.save([task(1, 'downloading', 40), task(2, 'ready', 100)]);
    events.next({ type: 'removed', id: '1', progress: 40 });
    await vi.waitFor(() => expect(service.tasks().map((t) => t.id)).toEqual([2]));
    expect(removeDownload).toHaveBeenCalledWith('1');
  });

  it('does not delete twice when the removal echoes back', async () => {
    cache.save([task(1, 'downloading', 40)]);
    const done = service.deleteDownload(service.tasks()[0]);
    events.next({ type: 'removed', id: '1', progress: 40 });
    await done;
    expect(removeDownload).toHaveBeenCalledTimes(1);
  });
});
