import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService } from './api/media.service';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';

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
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly mediaService = inject(MediaService);
  private readonly storage = inject(OfflineStorageService);
  private readonly cache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly auth = inject(AuthService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);

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
      // Pre-download subtitles for offline playback (fire-and-forget)
      void this.preDownloadSubtitles(taskId);
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

    // Hydrate a fresh long-lived stream JWT before we bake the URL +
    // header into the native download daemon — downloads can run for
    // hours so we can't rely on the 1h access token.
    await this.auth.ensureStreamToken();

    // Establish a live session the way playback does: the HLS segment routes
    // resolve the codec variant off the session via ?sid= and reject (410)
    // any segment request that can't resolve one. Thread the returned sid
    // into the baked URL; active segment fetches keep the session warm.
    const playbackInfo = await this.streamingApi.getPlaybackInfo(
      mediaFileId,
      this.deviceProfile.getProfile(),
      undefined,
      undefined,
      quality,
      undefined,
      /* download */ true,
    );
    const hlsUrl = this.streamingApi.getHlsUrl(
      mediaFileId,
      quality,
      undefined,
      playbackInfo.sessionId,
    );
    task.hlsUrl = hlsUrl;

    this.titles.set(taskId, { title, episode });
    this.persistTask(task);
    this.incActive();

    if (this.isNative) {
      const token =
        this.auth.streamToken() ?? this.auth.accessToken ?? '';
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
        void this.preDownloadSubtitles(downloadId);
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

  /** Download subtitle VTTs for offline playback. Called after native download completes. */
  private async preDownloadSubtitles(taskId: number) {
    const task = this.cache.load().find((t) => t.id === taskId);
    if (!task?.mediaId || !task.mediaFileId) return;
    try {
      const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
      const allSubs = await this.subtitlesApi.getForMedia(task.mediaId);
      const subs = allSubs.filter(
        (s) => s.mediaFileId === task.mediaFileId && !bitmapCodecs.has(s.codec ?? ''),
      );
      const offlineSubs: { key: string; language: string; label: string; forced?: boolean }[] = [];
      for (const sub of subs) {
        const url = sub.streamIndex != null
          ? this.streamingApi.getEmbeddedSubtitleUrl(task.mediaFileId, sub.streamIndex)
          : sub.relativePath
            ? this.streamingApi.getSubtitleUrl(task.mediaFileId, sub.id)
            : null;
        if (!url) continue;
        const key = `sub-${task.mediaFileId}-${sub.id}`;
        await this.storage.downloadSmallFile(url, key);
        offlineSubs.push({
          key,
          language: sub.language,
          label: `${sub.language}${sub.hearingImpaired ? ' (HI)' : ''}${sub.forced ? ' (Forced)' : ''}${sub.streamIndex != null ? ' [embedded]' : ''}`,
          forced: sub.forced,
        });
      }
      // Fetch audio stream info for offline audio track picker
      let audioStreams: { language?: string; title?: string; codec?: string; channels?: number }[] | undefined;
      try {
        const media = await this.mediaService.getOne(task.mediaId);
        const file = media.files?.find((f: any) => f.id === task.mediaFileId);
        const si = (file as any)?.streamInfo;
        if (si?.audio?.length > 1) {
          audioStreams = si.audio;
        }
      } catch { /* non-critical */ }

      // Persist subtitle + audio metadata on the task
      const tasks = this.cache.load();
      this.cache.save(tasks.map((t) =>
        t.id === taskId ? { ...t, offlineSubtitles: offlineSubs, ...(audioStreams ? { audioStreams } : {}) } : t,
      ));
    } catch (e) {
      console.warn('[DL] Failed to pre-download subtitles:', e);
    }
  }

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
