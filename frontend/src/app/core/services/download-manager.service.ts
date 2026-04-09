import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SseService } from './sse.service';
import {
  DownloadsApiService,
  DownloadTask,
} from './api/downloads-api.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService } from './download-cache.service';
import { DownloadNotificationService, NativeDownloadEvent } from './download-notification.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { ServerConfigService } from './server-config.service';
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
  private readonly sse = inject(SseService);
  private readonly api = inject(DownloadsApiService);
  private readonly storage = inject(OfflineStorageService);
  private readonly cache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);

  private readonly titles = new Map<number, { title: string; episode?: string }>();
  private activeCount = 0;
  private eventSeq = 0;

  /** Unified download event — fed by SSE (web) or native bridge (Android). */
  readonly lastDownloadEvent = signal<DownloadEvent | null>(null);

  private emitEvent(type: DownloadEvent['type'], taskId: number, progress: number, status?: string) {
    this.lastDownloadEvent.set({ type, taskId, progress, status, seq: ++this.eventSeq });
  }

  // --- Web: SSE listener (only active on non-native) ---
  private readonly sseEffect = effect(() => {
    if (this.isNative) return;
    const event = this.sse.lastEvent();
    if (!event) return;

    if (event.type === 'download.progress') {
      const id = event['downloadId'] as number;
      // Ignore events from other devices
      if (!this.titles.has(id) && !this.cache.has(id)) return;
      const pct = event['progress'] as number;
      const info = this.titles.get(id);
      this.notif.show(id, info?.title ?? 'Transcodage', pct, 'transcoding');
      this.emitEvent('progress', id, pct);
    } else if (event.type === 'download.ready') {
      const id = event['downloadId'] as number;
      if (!this.titles.has(id) && !this.cache.has(id)) return;
      this.emitEvent('ready', id, 100);
      void this.handleReadyWeb(id);
    } else if (event.type === 'download.failed') {
      const id = event['downloadId'] as number;
      if (!this.titles.has(id) && !this.cache.has(id)) return;
      const info = this.titles.get(id);
      this.notif.show(id, info?.title ?? 'Téléchargement', 0, 'error');
      this.emitEvent('failed', id, 0);
      this.decActive();
    }
  });

  // --- Native: Java service events (only active on native) ---
  private readonly nativeEffect = effect(() => {
    if (!this.isNative) return;
    const event = this.notif.nativeEvent();
    if (!event) return;

    this.emitEvent(event.type, event.taskId, event.progress, event.status);

    if (event.type === 'failed') {
      this.decActive();
    } else if (event.type === 'complete') {
      void this.handleNativeDownloadComplete(event.taskId);
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
      maxAudioChannels: dp.maxAudioChannels,
    });

    this.titles.set(task.id, { title, episode });
    this.persistTask(task);

    this.incActive();

    if (task.status === 'ready') {
      if (this.isNative) {
        // Native: Java service handles notification from startDownload
        void this.startNativeDownload(task);
      } else {
        this.notif.show(task.id, title, 0, 'downloading', episode);
        void this.handleReadyWeb(task.id);
      }
    } else {
      if (this.isNative) {
        // Native: Java service handles notification from setPollingConfig
        void this.startNativeTranscode(task.id, task.mediaFileId);
      } else {
        this.notif.show(task.id, title, 0, 'transcoding', episode);
      }
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
      void this.startNativeTranscode(taskId, task.mediaFileId);
    } else {
      this.notif.show(taskId, title, 0, 'transcoding', info?.episode);
    }
    return task;
  }

  async deleteDownload(task: DownloadTask) {
    await this.storage.delete(`download-${task.mediaFileId}`);
    this.api.delete(task.id).catch(() => {});
    this.cache.remove(task.id);
    this.titles.delete(task.id);
    // Cancel notification + remove from Java service tracking
    this.notif.dismiss(task.id);
    // Decrement active count if task was in progress
    if (['transcoding', 'remuxing', 'pending', 'ready'].includes(task.status)) {
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
            this.decActive();
            this.notif.stopService();
            continue;
          }
          // Not downloaded yet — restart
          if (this.isNative) {
            void this.startNativeDownload(task);
          } else {
            void this.handleReadyWeb(task.id);
          }
        } else if (task.status === 'failed') {
          this.emitEvent('failed', task.id, 0);
          this.decActive();
        } else if (task.status === 'transcoding' || task.status === 'remuxing') {
          this.emitEvent('progress', task.id, task.progress ?? 0, task.status);
        }
      }
    } catch {
      // Offline
    }
  }

  // ===== NATIVE PATHS =====

  /**
   * Start native Java polling for a transcode task.
   * Java polls server, updates notifications, chains to download when ready.
   */
  private async startNativeTranscode(taskId: number, mediaFileId?: number) {
    const baseUrl = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl('')
      : window.location.origin;
    const info = this.titles.get(taskId);
    const title = info?.title ?? 'Transcodage';
    const fileUrl = this.api.getFileUrl(taskId);
    const destPath = mediaFileId
      ? (await this.storage.getNativeDestPath(`download-${mediaFileId}`)) ?? ''
      : '';
    this.notif.startPolling(
      baseUrl, this.auth.accessToken ?? '', taskId, title,
      info?.episode, fileUrl, destPath, 0,
    );
  }

  /**
   * Start native Java download directly (no transcode needed).
   * Used when task.status is already 'ready'.
   */
  private async startNativeDownload(task: DownloadTask) {
    const url = this.api.getFileUrl(task.id);
    const destPath = await this.storage.getNativeDestPath(`download-${task.mediaFileId}`);
    if (!destPath) return;
    const info = this.titles.get(task.id);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';
    this.notif.nativeDownload(url, this.auth.accessToken ?? '', destPath, task.fileSize ?? 0, title, task.id);
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
   * Download to device via JS (web/iOS only). Never called on native.
   */
  private async handleReadyWeb(downloadId: number) {
    if (this.cache.isDownloading(downloadId)) return;

    let task: DownloadTask;
    try {
      task = await this.api.getOne(downloadId);
      if (task.status !== 'ready') return;
    } catch {
      return;
    }

    const hasLocal = await this.storage.has(`download-${task.mediaFileId}`);
    if (hasLocal) {
      this.decActive();
      return;
    }

    const info = this.titles.get(downloadId);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';

    this.cache.markDownloading(task.id);
    this.notif.show(downloadId, title, 0, 'downloading');

    try {
      const url = this.api.getFileUrl(task.id);
      await this.storage.download(
        url,
        `download-${task.mediaFileId}`,
        (pct) => {
          this.cache.updateProgress(task.id, pct);
          this.notif.show(downloadId, title, pct, 'downloading');
        },
      );

      if (task.subtitles?.length) {
        for (const sub of task.subtitles) {
          const subUrl = this.api.getSubtitleUrl(task.id, sub.filename);
          await this.storage.downloadSmallFile(
            subUrl,
            `download-${task.mediaFileId}-sub-${sub.filename}`,
          ).catch(() => {});
        }
      }

      await this.api.ackDownloaded(task.id).catch(() => {});
      this.persistTask(task);
      this.notif.show(downloadId, title, 100, 'complete');
    } catch {
      this.notif.show(downloadId, title, 0, 'error');
    } finally {
      this.cache.markDone(task.id);
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
    if (this.activeCount === 1) {
      this.notif.startService();
    }
  }

  private decActive() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    // Android: DownloadForegroundService already calls stopSelf() when the task queue is empty.
    // Calling stopService() here relaunches the service with STOP and runs cancel(NOTIFICATION_ID),
    // which can remove the "Terminé" notification when taskId maps to that id.
    if (this.activeCount === 0 && !this.isAndroid) {
      this.notif.stopService();
    }
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
      } else if (t.status === 'transcoding' || t.status === 'remuxing') {
        this.incActive();
        if (this.isNative) {
          void this.startNativeTranscode(t.id, t.mediaFileId);
        } else {
          const info = this.titles.get(t.id);
          this.notif.show(t.id, info?.title ?? 'Transcodage', t.progress ?? 0, t.status, info?.episode);
        }
      } else if (t.status === 'ready') {
        const hasLocal = await this.storage.has(`download-${t.mediaFileId}`);
        if (hasLocal) {
          this.cache.markLocal(t.id);
        } else {
          this.cache.removeLocal(t.id);
          this.incActive();
          if (this.isNative) {
            void this.startNativeDownload(t);
          } else {
            void this.handleReadyWeb(t.id);
          }
        }
      }
    }
  }
}
