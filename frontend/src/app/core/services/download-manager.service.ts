import { Injectable, inject, effect } from '@angular/core';
import { SseService } from './sse.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService } from './download-cache.service';

/**
 * Global service that listens for SSE download events and automatically
 * downloads completed transcode files to the device.
 * Inject in a root-level component to activate.
 */
@Injectable({ providedIn: 'root' })
export class DownloadManagerService {
  private readonly sse = inject(SseService);
  private readonly downloadsApi = inject(DownloadsApiService);
  private readonly offlineStorage = inject(OfflineStorageService);
  private readonly downloadCache = inject(DownloadCacheService);

  /** Effect created in constructor (injection context) — listens to SSE events */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;
    if (event.type === 'download.ready') {
      const downloadId = event['downloadId'] as number;
      void this.handleReady(downloadId);
    }
  });

  constructor() {
    // Recovery: check cached tasks for any that are 'ready' but not yet downloaded locally
    void this.recoverPendingDownloads();
  }

  private async recoverPendingDownloads() {
    const cached = this.downloadCache.load();
    for (const task of cached) {
      if (task.status === 'ready' && !this.downloadCache.isDownloading(task.id)) {
        const hasLocal = await this.offlineStorage.has(`download-${task.mediaFileId}`);
        if (!hasLocal) {
          void this.handleReady(task.id);
        }
      }
    }
  }

  private async handleReady(downloadId: number) {
    if (this.downloadCache.isDownloading(downloadId)) return;

    try {
      const task = await this.downloadsApi.getOne(downloadId);
      if (task.status !== 'ready') return;

      const hasLocal = await this.offlineStorage.has(`download-${task.mediaFileId}`);
      if (hasLocal) return;

      this.downloadCache.markDownloading(task.id);
      const url = this.downloadsApi.getFileUrl(task.id);
      try {
        await this.offlineStorage.download(
          url,
          `download-${task.mediaFileId}`,
          (pct) => this.downloadCache.updateProgress(task.id, pct),
        );
        if (task.subtitles?.length) {
          for (const sub of task.subtitles) {
            const subUrl = this.downloadsApi.getSubtitleUrl(task.id, sub.filename);
            await this.offlineStorage.downloadSmallFile(
              subUrl,
              `download-${task.mediaFileId}-sub-${sub.filename}`,
            ).catch(() => {});
          }
        }
        await this.downloadsApi.ackDownloaded(task.id).catch(() => {});
        this.downloadCache.save([
          ...this.downloadCache.load().filter((t) => t.id !== task.id),
          task,
        ]);
      } finally {
        this.downloadCache.markDone(task.id);
      }
    } catch {
      // API unreachable — will retry on next page load
    }
  }
}
