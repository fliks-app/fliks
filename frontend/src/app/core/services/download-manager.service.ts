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

  // --- Web: SSE listener for failures (only active on non-native) ---
  private readonly sseEffect = effect(() => {
    if (this.isNative) return;
    const event = this.sse.lastEvent();
    if (!event) return;
    if (event.type === 'download.failed') {
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

    if (this.isNative) {
      void this.startNativeProgressiveDownload(task);
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
      void this.startNativeProgressiveDownload(task);
    } else {
      void this.handleProgressiveWeb(task);
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
            this.decActive();
            this.notif.stopService();
            continue;
          }
          // Not downloaded yet — restart
          if (this.isNative) {
            void this.startNativeProgressiveDownload(task);
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
   * Progressive download: tell Java to poll for segments and download them
   * as they appear. Combines transcode + download into one phase.
   */
  private async startNativeProgressiveDownload(task: DownloadTask) {
    const baseUrl = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl('')
      : window.location.origin;
    const destDir = await this.storage.getNativeDestDir(`download-${task.mediaFileId}`);
    console.log('[DL] startNativeProgressiveDownload', {
      taskId: task.id, mediaFileId: task.mediaFileId, destDir, baseUrl,
      token: this.auth.accessToken ? '(set)' : '(null)',
    });
    if (!destDir) {
      console.error('[DL] destDir is null — aborting progressive download');
      return;
    }
    const info = this.titles.get(task.id);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';
    console.log('[DL] calling plugin progressiveDownload', { taskId: task.id, title, episode: info?.episode });
    this.notif.startProgressiveDownload(
      baseUrl, this.auth.accessToken ?? '', task.id,
      destDir, title, info?.episode, task.segmentDuration ?? 3,
    );
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
   * Progressive segment download for web (JS).
   * Polls `/status`, downloads segments as they appear, concatenates them
   * into a single fMP4 blob for offline storage via Cache API.
   */
  private async handleProgressiveWeb(task: DownloadTask) {
    const downloadId = task.id;
    if (this.cache.isDownloading(downloadId)) return;

    const hasLocal = await this.storage.has(`download-${task.mediaFileId}`);
    if (hasLocal) {
      this.decActive();
      return;
    }

    const info = this.titles.get(downloadId);
    const title = info?.title ?? task.media?.title ?? 'Téléchargement';
    this.cache.markDownloading(downloadId);
    this.notif.show(downloadId, title, 0, 'downloading');
    this.emitEvent('progress', downloadId, 0, 'downloading');

    try {
      const chunks: ArrayBuffer[] = [];
      let nextSeg = -1; // -1 = init.mp4 not yet fetched

      while (true) {
        const st = await this.api.getProgressiveStatus(downloadId);
        const available = st.segmentCount;
        const total = st.totalSegments ?? 0;
        const done = st.done;

        // Download init.mp4 first
        if (nextSeg === -1 && (available > 0 || done)) {
          chunks.push(await this.fetchSegment(downloadId, 'init.mp4'));
          nextSeg = 0;
        }

        // Download new segments
        while (nextSeg >= 0 && nextSeg < available) {
          const name = `seg-${String(nextSeg).padStart(4, '0')}.m4s`;
          chunks.push(await this.fetchSegment(downloadId, name));
          nextSeg++;

          const pct = total > 0 ? Math.min(99, Math.round((nextSeg / total) * 100)) : 0;
          this.cache.updateProgress(downloadId, pct);
          this.notif.show(downloadId, title, pct, 'downloading');
          this.emitEvent('progress', downloadId, pct, 'downloading');
        }

        if (done && nextSeg >= available) break;

        // Wait before next poll
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Concatenate all chunks into a single fMP4 blob and store
      const blob = new Blob(chunks, { type: 'video/mp4' });
      await this.storage.storeBlob(`download-${task.mediaFileId}`, blob);

      // Download subtitles
      const freshTask = await this.api.getOne(downloadId);
      if (freshTask.subtitles?.length) {
        for (const sub of freshTask.subtitles) {
          const subUrl = this.api.getSubtitleUrl(downloadId, sub.filename);
          await this.storage.downloadSmallFile(
            subUrl,
            `download-${task.mediaFileId}-sub-${sub.filename}`,
          ).catch(() => {});
        }
      }

      await this.api.ackDownloaded(downloadId).catch(() => {});
      this.persistTask(freshTask);
      this.notif.show(downloadId, title, 100, 'complete');
      this.emitEvent('complete', downloadId, 100);
    } catch (err) {
      this.notif.show(downloadId, title, 0, 'error');
      this.emitEvent('failed', downloadId, 0);
    } finally {
      this.cache.markDone(downloadId);
      this.decActive();
    }
  }

  private async fetchSegment(taskId: number, filename: string): Promise<ArrayBuffer> {
    const url = this.api.getSegmentUrl(taskId, filename);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.auth.accessToken}` },
    });
    if (!res.ok) throw new Error(`Segment ${filename} HTTP ${res.status}`);
    return res.arrayBuffer();
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
      } else if (t.status === 'transcoding' || t.status === 'ready') {
        const hasLocal = await this.storage.has(`download-${t.mediaFileId}`);
        if (t.status === 'ready' && hasLocal) {
          this.cache.markLocal(t.id);
        } else {
          if (hasLocal) this.cache.removeLocal(t.id);
          this.incActive();
          if (this.isNative) {
            void this.startNativeProgressiveDownload(t);
          } else {
            void this.handleProgressiveWeb(t);
          }
        }
      }
    }
  }
}
