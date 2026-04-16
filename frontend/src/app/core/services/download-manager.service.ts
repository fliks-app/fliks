import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StreamingApiService } from './api/streaming-api.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';

export interface DownloadEvent {
  type: 'progress' | 'ready' | 'failed' | 'complete';
  taskId: number;
  progress: number;
  /** Task status: 'downloading' | etc. */
  status?: string;
  /** Monotonic counter for signal uniqueness */
  seq: number;
}

/**
 * Single entry point for all download operations.
 *
 * Downloads are fully client-side:
 *   - Native (Android/iOS): ExoPlayer DownloadManager / AVAssetDownloadURLSession
 *   - Web: Shaka offline storage (IndexedDB)
 *   - UI tracking: DownloadCacheService (localStorage)
 *
 * No backend API involvement.
 */
@Injectable({ providedIn: 'root' })
export class DownloadManagerService {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly streamingApi = inject(StreamingApiService);
  private readonly storage = inject(OfflineStorageService);
  private readonly cache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly auth = inject(AuthService);

  private readonly titles = new Map<number, { title: string; episode?: string }>();
  private activeCount = 0;
  private eventSeq = 0;
  private nextLocalId = Date.now();

  /** Unified download event — fed by native bridge (Android/iOS) or Shaka (web). */
  readonly lastDownloadEvent = signal<DownloadEvent | null>(null);

  private emitEvent(type: DownloadEvent['type'], taskId: number, progress: number, status?: string) {
    this.lastDownloadEvent.set({ type, taskId, progress, status, seq: ++this.eventSeq });
  }

  // --- Native: ExoPlayer DownloadManager events ---
  private readonly nativeEffect = effect(() => {
    if (!this.isNative) return;
    const event = this.notif.nativeEvent();
    if (!event) return;

    const taskId = Number(event.id) || 0;
    this.emitEvent(
      event.type === 'removed' ? 'failed' : event.type,
      taskId,
      event.progress,
      event.state,
    );

    if (event.type === 'failed') {
      this.updateTaskStatus(taskId, 'failed', 0);
      this.decActive();
    } else if (event.type === 'complete') {
      this.updateTaskStatus(taskId, 'ready', 100);
      this.decActive();
    }
  });

  private recovered = false;

  /** Recover cached tasks once auth is ready. */
  private readonly authEffect = effect(() => {
    if (this.auth.isAuthenticated() && !this.recovered) {
      this.recovered = true;
      void this.recover();
    }
  });

  constructor() {
    window.addEventListener('online', () => {
      if (this.recovered) void this.recover();
    });
  }

  // ===== PUBLIC API =====

  async createDownload(
    mediaFileId: number,
    quality: string,
    title: string,
    episode?: string,
    meta?: { mediaId?: number; posterUrl?: string | null; type?: string },
  ): Promise<DownloadTask> {
    const taskId = this.nextLocalId++;
    const task: DownloadTask = {
      id: taskId,
      mediaId: meta?.mediaId ?? 0,
      mediaFileId,
      quality,
      status: 'transcoding',
      progress: 0,
      episodeLabel: episode,
      createdAt: new Date().toISOString(),
      media: { id: meta?.mediaId ?? 0, title, posterUrl: meta?.posterUrl ?? null, type: meta?.type ?? '' },
    };

    const hlsUrl = this.streamingApi.getHlsUrl(mediaFileId, quality);
    task.hlsUrl = hlsUrl;

    this.titles.set(taskId, { title, episode });
    this.persistTask(task);
    this.incActive();

    if (this.isNative) {
      const token = this.auth.accessToken ?? '';
      this.notif.startDownload(String(taskId), hlsUrl, token);
    } else {
      void this.handleWebDownload(task, hlsUrl);
    }

    return task;
  }

  async deleteDownload(task: DownloadTask) {
    if (this.isNative) {
      await this.notif.removeDownload(String(task.id));
    }
    await this.storage.delete(`download-${task.mediaFileId}`);
    this.cache.remove(task.id);
    this.cache.removeLocal(task.id);
    this.titles.delete(task.id);
    if (['transcoding', 'pending', 'ready'].includes(task.status)) {
      this.decActive();
    }
  }

  // ===== WEB PATH =====

  /**
   * Web offline download using Shaka's built-in offline storage API.
   */
  private async handleWebDownload(task: DownloadTask, hlsUrl: string) {
    const downloadId = task.id;
    if (this.cache.isDownloading(downloadId)) return;

    const offlineUri = this.storage.getShakaOfflineUri(task.mediaFileId);
    if (offlineUri) {
      this.decActive();
      return;
    }

    const info = this.titles.get(downloadId);
    const title = info?.title ?? task.media?.title ?? 'Download';
    this.cache.markDownloading(downloadId);
    this.emitEvent('progress', downloadId, 0, 'downloading');

    try {
      const storedUri = await this.storage.shakaStore(
        hlsUrl,
        task.mediaFileId,
        { title, episode: info?.episode },
        (progress) => {
          const pct = Math.round(progress * 100);
          this.cache.updateProgress(downloadId, pct);
          this.emitEvent('progress', downloadId, pct, 'downloading');
        },
      );

      if (storedUri) {
        this.updateTaskStatus(downloadId, 'ready', 100);
        this.emitEvent('complete', downloadId, 100);
      } else {
        throw new Error('Shaka offline store returned null');
      }
    } catch (err) {
      console.error('[DL] Shaka offline store failed:', err);
      this.updateTaskStatus(downloadId, 'failed', 0);
      this.emitEvent('failed', downloadId, 0);
    } finally {
      this.cache.markDone(downloadId);
      this.decActive();
    }
  }

  // ===== HELPERS =====

  private persistTask(task: DownloadTask) {
    this.cache.save([
      ...this.cache.load().filter((t) => t.id !== task.id),
      task,
    ]);
  }

  private updateTaskStatus(taskId: number, status: string, progress: number) {
    const tasks = this.cache.load();
    const updated = tasks.map((t) =>
      t.id === taskId ? { ...t, status, progress } : t,
    );
    this.cache.save(updated);
    if (status === 'ready') this.cache.markLocal(taskId);
  }

  private incActive() {
    this.activeCount++;
  }

  private decActive() {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  /**
   * Recover download state from localStorage cache.
   * Re-populates the titles map for UI display.
   */
  private async recover() {
    const tasks = this.cache.load();

    for (const t of tasks) {
      if (t.media?.title) {
        this.titles.set(t.id, { title: t.media.title, episode: t.episodeLabel });
      }
    }

    // Prune tasks whose local content is gone
    for (const t of tasks) {
      if (t.status === 'ready') {
        // Native: trust localStorage — ExoPlayer's SimpleCache persists across
        // restarts and querying DownloadIndex has timing issues.
        // Web: verify Shaka offline URI still exists in localStorage.
        if (!this.isNative) {
          const hasLocal = await this.storage.has(`download-${t.mediaFileId}`);
          if (!hasLocal) {
            this.cache.remove(t.id);
            this.cache.removeLocal(t.id);
          }
        }
      } else if (t.status === 'failed') {
        // Remove stale failed tasks
        this.cache.remove(t.id);
      }
    }
  }
}
