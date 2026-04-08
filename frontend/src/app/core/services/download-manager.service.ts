import { Injectable, inject, effect } from '@angular/core';
import { SseService } from './sse.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';

/**
 * Global service that listens for SSE download events and automatically
 * downloads completed transcode files to the device.
 * Shows native system notifications with progress bars.
 */
@Injectable({ providedIn: 'root' })
export class DownloadManagerService {
  private readonly sse = inject(SseService);
  private readonly downloadsApi = inject(DownloadsApiService);
  private readonly offlineStorage = inject(OfflineStorageService);
  private readonly downloadCache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);

  /** Track media titles for notifications */
  private readonly taskTitles = new Map<number, string>();
  /** Last SSE progress timestamp per task — for stall detection */
  private readonly lastProgressAt = new Map<number, number>();
  private stallCheckTimer?: ReturnType<typeof setInterval>;

  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;

    if (event.type === 'download.progress') {
      const downloadId = event['downloadId'] as number;
      if (this.downloadCache.getDismissed().has(downloadId)) return;
      const progress = event['progress'] as number;
      this.lastProgressAt.set(downloadId, Date.now());
      const title = this.taskTitles.get(downloadId) ?? 'Transcodage';
      this.notif.startService(); // Ensure service is running for background transcode
      this.notif.show(downloadId, title, progress, 'transcoding');
    } else if (event.type === 'download.ready') {
      const downloadId = event['downloadId'] as number;
      if (this.downloadCache.getDismissed().has(downloadId)) return;
      this.lastProgressAt.delete(downloadId);
      void this.handleReady(downloadId);
    } else if (event.type === 'download.failed') {
      const downloadId = event['downloadId'] as number;
      if (this.downloadCache.getDismissed().has(downloadId)) return;
      this.lastProgressAt.delete(downloadId);
      const title = this.taskTitles.get(downloadId) ?? 'Téléchargement';
      this.notif.show(downloadId, title, 0, 'error');
      // Stop service if nothing else active
      if (this.lastProgressAt.size === 0 && this.downloadCache.activeDownloads().size === 0) {
        this.notif.stopService();
      }
    }
  });

  constructor() {
    // Kill foreground service + clear ALL notifications from previous session
    this.notif.stopService();
    this.notif.dismissAll();
    void this.recoverAndSync();
    // Check for stalled transcodes every 30s
    this.stallCheckTimer = setInterval(() => this.checkStalled(), 30_000);
  }

  /**
   * If no SSE progress received for 60s on a tracked task,
   * poll server for actual status. If failed or unreachable → mark as error.
   */
  private async checkStalled() {
    const now = Date.now();
    const staleThreshold = 60_000;

    const dismissed = this.downloadCache.getDismissed();
    for (const [taskId, lastTime] of this.lastProgressAt) {
      if (now - lastTime < staleThreshold) continue;
      if (dismissed.has(taskId)) { this.lastProgressAt.delete(taskId); continue; }

      // No progress in 60s — check server
      try {
        const task = await this.downloadsApi.getOne(taskId);
        if (task.status === 'failed') {
          this.lastProgressAt.delete(taskId);
          // Don't show notification for stale failed tasks — just clean up
          this.notif.dismiss(taskId);
        } else if (task.status === 'ready') {
          this.lastProgressAt.delete(taskId);
          void this.handleReady(taskId);
        }
        // Still transcoding → update timestamp so we don't re-poll immediately
        if (task.status === 'transcoding' || task.status === 'remuxing') {
          this.lastProgressAt.set(taskId, now);
        }
      } catch {
        // Server unreachable → mark as failed locally
        this.lastProgressAt.delete(taskId);
        const title = this.taskTitles.get(taskId) ?? 'Téléchargement';
        this.notif.show(taskId, title, 0, 'error');
      }
    }
  }

  /**
   * Called immediately when user creates a download.
   * Starts the foreground service + shows initial notification.
   */
  onDownloadCreated(taskId: number, title: string, status: string) {
    this.taskTitles.set(taskId, title);
    this.lastProgressAt.set(taskId, Date.now());
    this.notif.startService();
    const notifStatus = status === 'ready' ? 'downloading' : 'transcoding';
    this.notif.show(taskId, title, 0, notifStatus);
  }

  /**
   * Called when app resumes from background.
   * Re-checks server for any status changes that happened while JS was suspended.
   */
  async syncAfterResume() {
    try {
      const tasks = await this.downloadsApi.list();
      for (const task of tasks) {
        const title = this.taskTitles.get(task.id);
        if (!title) continue;

        if (task.status === 'ready' && this.lastProgressAt.has(task.id)) {
          // Was transcoding, now ready → switch to downloading
          this.lastProgressAt.delete(task.id);
          void this.handleReady(task.id);
        } else if (task.status === 'failed' && this.lastProgressAt.has(task.id)) {
          // Was transcoding, now failed
          this.lastProgressAt.delete(task.id);
          this.notif.show(task.id, title, 0, 'error');
          if (this.lastProgressAt.size === 0 && this.downloadCache.activeDownloads().size === 0) {
            this.notif.stopService();
          }
        } else if ((task.status === 'transcoding' || task.status === 'remuxing') && this.lastProgressAt.has(task.id)) {
          // Still transcoding — update progress in notif
          this.notif.show(task.id, title, task.progress ?? 0, task.status);
        }
      }
    } catch {
      // Offline
    }
  }

  /** Register a task title for notification display */
  registerTitle(taskId: number, title: string) {
    this.taskTitles.set(taskId, title);
  }

  /**
   * On app startup: sync cached tasks with server state, then recover.
   * - Tasks that became 'ready' while app was closed → start device download
   * - Tasks still 'transcoding' on server → just update cache (SSE will handle progress)
   * - Stale notifications → dismiss
   */
  private async recoverAndSync() {
    const cached = this.downloadCache.load();

    // Try to sync with server for fresh status
    let tasks = cached;
    try {
      tasks = await this.downloadsApi.list();
      this.downloadCache.save(tasks);
    } catch {
      // Offline — use cached
    }

    // Register titles
    for (const task of tasks) {
      if (task.media?.title) {
        const epLabel = task.episodeLabel ? ` — ${task.episodeLabel}` : '';
        this.taskTitles.set(task.id, `${task.media.title}${epLabel}`);
      }
    }

    // Build set of tasks to ignore: dismissed by user + failed/expired
    const dismissed = this.downloadCache.getDismissed();
    const ignore = new Set<number>();
    for (const task of tasks) {
      if (dismissed.has(task.id) || task.status === 'failed' || task.status === 'expired') {
        ignore.add(task.id);
        // Delete from server
        this.downloadsApi.delete(task.id).catch(() => {});
      }
    }

    // Only auto-resume tasks that were actively downloading when the app was killed.
    // Do NOT auto-start downloads for tasks the user never initiated on this device.
    for (const task of tasks) {
      if (ignore.has(task.id)) continue;
      if (task.status === 'transcoding' || task.status === 'remuxing') {
        // Server still processing — track for stall detection, SSE will handle notifications
        this.lastProgressAt.set(task.id, Date.now());
      }
      // 'ready' tasks are NOT auto-downloaded at startup.
      // The user must be on the downloads page or initiate the download explicitly.
      // The SSE 'download.ready' event handles auto-download for NEW transcodes.
    }

    // Clear dismissed AFTER processing (so next restart won't re-process)
    if (dismissed.size) {
      try { localStorage.removeItem('fliks.downloads.dismissed'); } catch {}
    }
  }

  private async handleReady(downloadId: number) {
    if (this.downloadCache.isDownloading(downloadId)) return;

    try {
      const task = await this.downloadsApi.getOne(downloadId);
      if (task.status !== 'ready') return;

      const hasLocal = await this.offlineStorage.has(`download-${task.mediaFileId}`);
      if (hasLocal) return;

      const baseTitle = task.media?.title ?? '';
      const epLabel = task.episodeLabel ? ` — ${task.episodeLabel}` : '';
      const title = this.taskTitles.get(downloadId) ?? (`${baseTitle}${epLabel}` || 'Téléchargement');
      this.taskTitles.set(downloadId, title);

      this.downloadCache.markDownloading(task.id);
      this.notif.startService();
      this.notif.show(downloadId, title, 0, 'downloading');

      const url = this.downloadsApi.getFileUrl(task.id);
      try {
        await this.offlineStorage.download(
          url,
          `download-${task.mediaFileId}`,
          (pct) => {
            this.downloadCache.updateProgress(task.id, pct);
            this.notif.show(downloadId, title, pct, 'downloading');
          },
        );
        // Download VTT subtitles
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
        this.notif.show(downloadId, title, 100, 'complete');
      } catch {
        this.notif.show(downloadId, title, 0, 'error');
      } finally {
        this.downloadCache.markDone(task.id);
        // Stop service if no more active downloads
        if (this.downloadCache.activeDownloads().size === 0) {
          this.notif.stopService();
        }
      }
    } catch {
      // API unreachable
    }
  }
}
