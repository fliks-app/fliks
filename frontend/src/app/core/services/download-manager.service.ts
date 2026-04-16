import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import shaka from 'shaka-player';
import {
  DownloadsApiService,
  DownloadTask,
} from './api/downloads-api.service';
import { StreamingApiService } from './api/streaming-api.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { AuthService } from './auth.service';

export interface DownloadEvent {
  type: 'progress' | 'ready' | 'failed' | 'complete';
  taskId: number;
  progress: number;
  /** Task status from native: 'transcoding' | 'downloading' | etc. */
  status?: string;
  /** Monotonic counter for signal uniqueness */
  seq: number;
}

/**
 * Single entry point for all download operations.
 *
 * Event sources:
 *   - Web: SSE from server (download.progress / download.ready / download.failed)
 *   - Native (Android): Java foreground service → Capacitor plugin → nativeEvent signal
 *
 * On native, ALL work (transcode polling + file download) happens in Java.
 * SSE download events are ignored. Java notifies WebView so UI stays in sync.
 */
@Injectable({ providedIn: 'root' })
export class DownloadManagerService {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly isAndroid = Capacitor.getPlatform() === 'android';
  private readonly api = inject(DownloadsApiService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly storage = inject(OfflineStorageService);
  private readonly cache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly auth = inject(AuthService);

  private readonly titles = new Map<number, { title: string; episode?: string }>();
  private activeCount = 0;
  private eventSeq = 0;

  /** Unified download event — fed by SSE (web) or native bridge (Android). */
  readonly lastDownloadEvent = signal<DownloadEvent | null>(null);

  private emitEvent(type: DownloadEvent['type'], taskId: number, progress: number, status?: string) {
    this.lastDownloadEvent.set({ type, taskId, progress, status, seq: ++this.eventSeq });
  }

  // --- Native: ExoPlayer DownloadManager events ---
  private readonly nativeEffect = effect(() => {
    if (!this.isNative) return;
    const event = this.notif.nativeEvent();
    if (!event) return;

    // Map native string id back to numeric task id
    const taskId = Number(event.id) || 0;
    this.emitEvent(
      event.type === 'removed' ? 'failed' : event.type,
      taskId,
      event.progress,
      event.state,
    );

    if (event.type === 'failed') {
      this.decActive();
    } else if (event.type === 'complete') {
      void this.handleNativeDownloadComplete(taskId);
    }
  });

  private recovered = false;

  /** Recover once auth is ready (token needed for API calls and native polling) */
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
  ): Promise<DownloadTask> {
    const dp = this.deviceProfile.getProfile();
    const task = await this.api.create(mediaFileId, quality, {
      supportsHdr: dp.supportsHdr,
      audioCodecs: dp.directPlayProfiles[0]?.audioCodecs,
      videoCodecs: dp.directPlayProfiles[0]?.videoCodecs,
      maxAudioChannels: dp.maxAudioChannels,
    });

    this.titles.set(task.id, { title, episode });
    this.persistTask(task);

    this.incActive();

    if (this.isNative) {
      this.startNativeDownload(task);
    } else {
      void this.handleProgressiveWeb(task);
    }

    return task;
  }

  async retryDownload(taskId: number): Promise<DownloadTask> {
    const dp = this.deviceProfile.getProfile();
    const task = await this.api.retry(taskId, {
      supportsHdr: dp.supportsHdr,
      audioCodecs: dp.directPlayProfiles[0]?.audioCodecs,
      maxAudioChannels: dp.maxAudioChannels,
    });
    this.persistTask(task);

    this.incActive();
    const info = this.titles.get(taskId);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';
    if (this.isNative) {
      this.startNativeDownload(task);
    } else {
      void this.handleProgressiveWeb(task);
    }
    return task;
  }

  async deleteDownload(task: DownloadTask) {
    await this.storage.delete(`download-${task.mediaFileId}`);
    this.api.delete(task.id).catch(() => {});
    this.cache.remove(task.id);
    this.cache.removeLocal(task.id);
    this.titles.delete(task.id);
    // Native: remove from ExoPlayer DownloadManager
    this.notif.removeDownload(String(task.id));
    if (['transcoding', 'pending', 'ready'].includes(task.status)) {
      this.decActive();
    }
  }

  async syncAfterResume() {
    try {
      const tasks = await this.api.list();
      for (const task of tasks) {
        const info = this.titles.get(task.id);
        if (!info) continue;

        if (task.status === 'ready') {
          const hasLocal = await this.storage.has(`download-${task.mediaFileId}`);
          if (hasLocal) {
            this.api.ackDownloaded(task.id).catch(() => {});
            this.persistTask(task);
            this.cache.markDone(task.id);
            // Don't call stopService() — Java's promoteOrStop() handles
            // shutdown when its task queue empties. Calling STOP here kills
            // in-flight progressive downloads on other tasks.
            continue;
          }
          // Not downloaded yet — restart
          if (this.isNative) {
            this.startNativeDownload(task);
          } else {
            void this.handleProgressiveWeb(task);
          }
        } else if (task.status === 'failed') {
          this.emitEvent('failed', task.id, 0);
          this.decActive();
        } else if (task.status === 'transcoding') {
          this.emitEvent('progress', task.id, task.progress ?? 0, task.status);
        }
      }
    } catch {
      // Offline
    }
  }

  // ===== NATIVE PATHS =====

  /**
   * Start a native download via ExoPlayer DownloadManager (Android) or
   * AVAssetDownloadTask (iOS). The native API handles fetching the HLS
   * manifest + segments, caching, resume, notifications — everything.
   */
  private startNativeDownload(task: DownloadTask): void {
    const hlsUrl = this.streamingApi.getHlsUrl(task.mediaFileId, task.quality);
    const token = this.auth.accessToken ?? '';
    this.notif.startDownload(String(task.id), hlsUrl, token);
  }

  /**
   * Native download completed — ACK server and persist task.
   */
  private async handleNativeDownloadComplete(taskId: number) {
    try {
      const task = await this.api.getOne(taskId);
      await this.api.ackDownloaded(taskId).catch(() => {});
      this.persistTask(task);
    } catch {
      // Will be handled by syncAfterResume
    } finally {
      this.cache.markDone(taskId);

      this.decActive();
    }
  }

  // ===== WEB PATH =====

  /**
   * Web offline download using Shaka's built-in offline storage API.
   * Shaka handles manifest parsing, segment download, IndexedDB storage,
   * and offline playback via `offline:` URIs — no custom Cache API, no
   * Service Worker, no manual manifest generation.
   */
  private async handleProgressiveWeb(task: DownloadTask) {
    const downloadId = task.id;
    if (this.cache.isDownloading(downloadId)) return;

    const offlineUri = this.storage.getShakaOfflineUri(task.mediaFileId);
    if (offlineUri) {
      // Already stored in Shaka offline — nothing to do
      this.decActive();
      return;
    }

    const info = this.titles.get(downloadId);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';
    this.cache.markDownloading(downloadId);
    // Notification handled by Shaka progress callback below
    this.emitEvent('progress', downloadId, 0, 'downloading');

    try {
      // Use Shaka's offline storage to download the HLS stream into IndexedDB.
      // The streaming endpoint serves the manifest immediately and blocks on
      // segment requests until the transcode produces them.
      const hlsUrl = this.streamingApi.getHlsUrl(task.mediaFileId, task.quality);
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
        await this.api.ackDownloaded(downloadId).catch(() => {});
        const freshTask = await this.api.getOne(downloadId);
        this.persistTask(freshTask);
          this.emitEvent('complete', downloadId, 100);
      } else {
        throw new Error('Shaka offline store returned null');
      }
    } catch (err) {
      console.error('[DL] Shaka offline store failed:', err);
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

  private incActive() {
    this.activeCount++;
  }

  private decActive() {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  private async recover() {
    let tasks: DownloadTask[];
    try {
      tasks = await this.api.list();
      this.cache.save(tasks);
    } catch {
      tasks = this.cache.load();
    }

    for (const t of tasks) {
      if (t.media?.title) {
        this.titles.set(t.id, { title: t.media.title, episode: t.episodeLabel });
      }
    }

    // Prune localTaskIds for tasks gone from server
    const serverIds = new Set(tasks.map((t) => t.id));
    for (const id of this.cache.localTaskIds()) {
      if (!serverIds.has(id)) this.cache.removeLocal(id);
    }

    for (const t of tasks) {
      if (t.status === 'failed' || t.status === 'expired') {
        this.api.delete(t.id).catch(() => {});
      } else if (t.status === 'transcoding' || t.status === 'ready') {
        const hasLocal = await this.storage.has(`download-${t.mediaFileId}`);
        if (t.status === 'ready' && hasLocal) {
          this.cache.markLocal(t.id);
        } else {
          if (hasLocal) this.cache.removeLocal(t.id);
          this.incActive();
          if (this.isNative) {
            this.startNativeDownload(t);
          } else {
            void this.handleProgressiveWeb(t);
          }
        }
      }
    }
  }
}
