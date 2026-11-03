import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoDownloadService } from './auto-download.service';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { AuthService } from './auth.service';
import { TvService } from './tv.service';
import { AppResumeService } from './app-resume.service';
import { DownloadManagerService } from './download-manager.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadSettingsService } from './download-settings.service';
import { StorageScopeService } from './storage-scope.service';
import { MediaService } from './api/media.service';
import { StreamingApiService } from './api/streaming-api.service';
import { PlaylistsApiService } from './api/playlists-api.service';

const task = (id: number, itemId: number, createdAt: string): DownloadTask => ({
  id, mediaId: 3, mediaFileId: 1, quality: 'file', status: 'ready', progress: 100, createdAt,
  book: { itemId, family: 'audio', format: 'm4b', files: [] },
});

function setup(tasks: DownloadTask[], state: unknown, open: { playing?: number; url?: string } = {}) {
  const deleteDownload = vi.fn(async (..._a: unknown[]) => undefined);
  const getPlaybackState = vi.fn(async (..._a: unknown[]) => state);
  TestBed.configureTestingModule({
    providers: [
      AutoDownloadService,
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: AuthService, useValue: {} },
      { provide: AppResumeService, useValue: {} },
      { provide: DownloadManagerService, useValue: { deleteDownload } },
      { provide: DownloadCacheService, useValue: { load: () => tasks } },
      { provide: StreamingApiService, useValue: { getPlaybackState } },
      { provide: DownloadSettingsService, useValue: { autoDeleteBooks: () => true } },
      { provide: PlaylistsApiService, useValue: {} },
      { provide: StorageScopeService, useValue: {} },
      { provide: MediaService, useValue: {} },
      { provide: AudioPlayerService, useValue: { track: () => (open.playing == null ? null : { itemId: open.playing }) } },
      { provide: Router, useValue: { url: open.url ?? '/' } },
    ],
  });
  const run = () => (TestBed.inject(AutoDownloadService) as unknown as { deleteFinishedBooks(): Promise<void> }).deleteFinishedBooks();
  return { run, deleteDownload, getPlaybackState };
}

describe('AutoDownloadService, delete finished books', () => {
  afterEach(() => TestBed.resetTestingModule());
  const done = { completed: true, lastPlayedAt: '2026-02-01T00:00:00Z' };

  it('removes a copy whose item was finished after it was saved, asking per item', async () => {
    const { run, deleteDownload, getPlaybackState } = setup([task(1, 40, '2026-01-01T00:00:00Z')], done);
    await run();
    expect(getPlaybackState).toHaveBeenCalledWith(3, undefined, 40);
    expect(deleteDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps a copy saved after the item was finished', async () => {
    const { run, deleteDownload } = setup([task(1, 40, '2026-03-01T00:00:00Z')], done);
    await run();
    expect(deleteDownload).not.toHaveBeenCalled();
  });

  it('keeps an item that is playing or open in the reader', async () => {
    const playing = setup([task(1, 40, '2026-01-01T00:00:00Z')], done, { playing: 40 });
    await playing.run();
    expect(playing.deleteDownload).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    const reading = setup([task(1, 40, '2026-01-01T00:00:00Z')], done, { url: '/read/3/40' });
    await reading.run();
    expect(reading.deleteDownload).not.toHaveBeenCalled();
  });
});
