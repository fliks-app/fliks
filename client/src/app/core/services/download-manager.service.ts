import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService } from './api/media.service';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { TranslateService } from '@ngx-translate/core';
import { formatSubtitleLabel } from '../utils/player.utils';
import { AppSettingsService } from './app-settings.service';
import {
  desktopDownloaderOrNull,
  type DesktopDownloadStatus,
} from '../plugins/desktop-downloader.bridge';

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
  /** Electron desktop backend: download the original file to disk, play via mpv. */
  private readonly downloader = desktopDownloaderOrNull();
  private get isDesktop(): boolean {
    return !!this.downloader;
  }
  private readonly streamingApi = inject(StreamingApiService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly mediaService = inject(MediaService);
  private readonly storage = inject(OfflineStorageService);
  private readonly cache = inject(DownloadCacheService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly auth = inject(AuthService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly translate = inject(TranslateService);
  private readonly appSettings = inject(AppSettingsService);

  private readonly titles = new Map<number, { title: string; episode?: string }>();
  private eventSeq = 0;
  private nextLocalId = Date.now();

  // Cap concurrent web downloads (each spins up a hidden player + Shaka store);
  // native downloads are queued by the OS daemon and don't come through here.
  private static readonly MAX_WEB_CONCURRENT = 2;
  private webActive = 0;
  private readonly webQueue: Array<() => void> = [];

  /** Unified download event — fed by native bridge (Android/iOS) or Shaka (web). */
  readonly lastDownloadEvent = signal<DownloadEvent | null>(null);

  /** Bumped when {@link recover} finishes, so the auto-download reconciler runs
   *  after interrupted tasks are cleaned up instead of racing that pass. */
  readonly recoveredAt = signal(0);

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
    } else if (event.type === 'complete') {
      this.updateTaskStatus(taskId, 'ready', 100);
      // Pre-download subtitles for offline playback (fire-and-forget)
      void this.preDownloadSubtitles(taskId);
    }
  });

  /** Session epoch already recovered, or -1. The task list is scoped to the
   *  (server, user) pair that owns it, so each session recovers once. */
  private recoveredEpoch = -1;

  private readonly authEffect = effect(() => {
    const epoch = this.auth.sessionEpoch();
    if (this.auth.isAuthenticated() && epoch !== this.recoveredEpoch) {
      this.recoveredEpoch = epoch;
      void this.recover(true);
    }
  });

  constructor() {
    window.addEventListener('online', () => {
      if (this.recoveredEpoch >= 0) void this.recover();
    });
    this.downloader?.onStatus((s) => this.onDesktopStatus(s));
  }

  /** Map a desktop (Electron) download status event onto the cache task keyed
   *  by mediaFileId. Progress drives the badge; done pre-fetches subtitles. */
  private onDesktopStatus(s: DesktopDownloadStatus): void {
    const mfid = Number(s.id);
    const task = this.cache
      .load()
      .find((t) => t.mediaFileId === mfid && t.status !== 'ready' && t.status !== 'failed');
    if (!task) return;
    if (s.state === 'progress') {
      const pct = s.total > 0 ? Math.round((s.received / s.total) * 100) : 0;
      this.cache.updateProgress(task.id, pct);
      this.emitEvent('progress', task.id, pct, 'downloading');
    } else if (s.state === 'done') {
      this.updateTaskStatus(task.id, 'ready', 100);
      this.emitEvent('complete', task.id, 100);
      void this.preDownloadSubtitles(task.id);
    } else {
      this.updateTaskStatus(task.id, 'failed', 0);
      this.emitEvent('failed', task.id, 0);
    }
  }

  // ===== PUBLIC API =====

  async createDownload(
    mediaFileId: number,
    quality: string,
    title: string,
    episode?: string,
    meta?: {
      mediaId?: number;
      posterUrl?: string | null;
      type?: string;
      episodeId?: number;
      /** Set by the auto-download reconciler; enables auto-delete-after-watched. */
      auto?: boolean;
    },
  ): Promise<DownloadTask> {
    const taskId = this.nextLocalId++;
    const task: DownloadTask = {
      id: taskId,
      mediaId: meta?.mediaId ?? 0,
      episodeId: meta?.episodeId,
      mediaFileId,
      quality,
      status: 'transcoding',
      progress: 0,
      episodeLabel: episode,
      auto: meta?.auto,
      createdAt: new Date().toISOString(),
      media: { id: meta?.mediaId ?? 0, title, posterUrl: meta?.posterUrl ?? null, type: meta?.type ?? '' },
    };

    // Desktop keeps a single offline copy per file (the disk key + status
    // events are keyed by mediaFileId), so a new download replaces any prior
    // one for the same file instead of colliding with it.
    if (this.isDesktop) {
      for (const prev of this.cache
        .load()
        .filter((t) => t.mediaFileId === mediaFileId)) {
        await this.deleteDownload(prev);
      }
    }

    // Hydrate a fresh long-lived stream JWT before we bake the URL +
    // header into the native download daemon — downloads can run for
    // hours so we can't rely on the 1h access token.
    await this.auth.ensureStreamToken();

    // Desktop (Electron), original: fetch the untouched container straight to
    // disk and play it offline via mpv (full codec coverage). No HLS session —
    // the raw ?download=1 route streams the file with Range support.
    if (this.isDesktop && quality === 'original') {
      const url = this.streamingApi.getOriginalDownloadUrl(mediaFileId);
      task.hlsUrl = url;
      this.titles.set(taskId, { title, episode });
      this.persistTask(task);
      void this.downloader!.start({
        id: String(mediaFileId),
        url,
        filename: episode ? `${title} - ${episode}` : title,
      });
      this.emitEvent('progress', taskId, 0, 'downloading');
      return task;
    }

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

    if (this.isDesktop) {
      // Desktop, transcoded rung: mirror the HLS bundle to disk and play it
      // offline via mpv (the local master.m3u8) — like the native offline flow.
      void this.downloader!.start({
        id: String(mediaFileId),
        url: hlsUrl,
        quality,
        filename: episode ? `${title} - ${episode}` : title,
      });
      this.emitEvent('progress', taskId, 0, 'downloading');
    } else if (this.isNative) {
      const token =
        this.auth.streamToken() ?? this.auth.accessToken ?? '';
      // Pre-translated banner copy for the iOS completion/failure notification
      // (ngx-translate is the single source of user-facing strings; the native
      // side never hardcodes text). Ignored on Android.
      const notifTitle = episode ? `${title} · ${episode}` : title;
      this.notif.startDownload(String(taskId), hlsUrl, token, {
        notifTitle,
        notifComplete: this.translate.instant('downloads.notif_complete'),
        notifFailed: this.translate.instant('downloads.notif_failed'),
      });
    } else {
      this.enqueueWeb(task, hlsUrl);
    }

    return task;
  }

  async deleteDownload(task: DownloadTask) {
    if (this.isNative) {
      await this.notif.removeDownload(String(task.id));
    }
    // Media, Shaka URI and VTTs are keyed by mediaFileId and shared with any
    // sibling task for the same file — only remove them when none remains.
    const sharedElsewhere = this.cache
      .load()
      .some(
        (t) =>
          t.id !== task.id &&
          t.mediaFileId === task.mediaFileId &&
          t.status !== 'failed',
      );
    if (!sharedElsewhere) {
      await this.storage.delete(`download-${task.mediaFileId}`);
      for (const sub of task.offlineSubtitles ?? []) {
        await this.storage.deleteSmallFile(sub.key);
      }
    }
    this.cache.remove(task.id);
    this.cache.removeLocal(task.id);
    this.titles.delete(task.id);
  }

  // ===== WEB PATH =====

  /** Run a web download now if under the concurrency cap, else queue it. */
  private enqueueWeb(task: DownloadTask, hlsUrl: string) {
    const run = async () => {
      this.webActive++;
      try {
        await this.handleWebDownload(task, hlsUrl);
      } finally {
        this.webActive--;
        this.webQueue.shift()?.();
      }
    };
    if (this.webActive < DownloadManagerService.MAX_WEB_CONCURRENT) {
      void run();
    } else {
      this.webQueue.push(() => void run());
    }
  }

  /**
   * Web offline download using Shaka's built-in offline storage API.
   */
  private async handleWebDownload(task: DownloadTask, hlsUrl: string) {
    const downloadId = task.id;
    if (this.cache.isDownloading(downloadId)) return;

    const offlineUri = this.storage.getShakaOfflineUri(task.mediaFileId);
    if (offlineUri) {
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
    }
  }

  // ===== HELPERS =====

  /** Download subtitle VTTs for offline playback. Called after native download completes. */
  private async preDownloadSubtitles(taskId: number) {
    const task = this.cache.load().find((t) => t.id === taskId);
    if (!task?.mediaId || !task.mediaFileId) return;
    try {
      const allSubs = await this.subtitlesApi.getForMedia(task.mediaId);
      const subs = allSubs.filter(
        (s) => s.mediaFileId === task.mediaFileId && !isImageBasedSubtitleCodec(s.codec),
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
        // Only record the subtitle if its VTT was actually written — a dangling
        // entry makes offline playback attach a subtitle track that renders nothing.
        const stored = await this.storage.downloadSmallFile(url, key);
        if (!stored) continue;
        offlineSubs.push({
          key,
          language: sub.language,
          // Same normalized label as online playback (localized language name +
          // HI/Forced) instead of the raw language code.
          label: formatSubtitleLabel(sub, this.translate, offlineSubs.length + 1, {
            showFormat: this.appSettings.showSubtitleFormat(),
          }),
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

  /**
   * Recover download state from localStorage cache.
   * Re-populates the titles map for UI display.
   *
   * `onStartup` = the app just (re)launched, so every in-flight task is a
   * leftover from before and its session is dead; on a mere reconnect,
   * in-flight downloads may still be live, so only the untracked ones are failed.
   */
  private async recover(onStartup = false) {
    const tasks = this.cache.load();

    for (const t of tasks) {
      if (t.media?.title) {
        this.titles.set(t.id, { title: t.media.title, episode: t.episodeLabel });
      }
    }

    const nativeById = new Map<string, { id: string; progress: number; state: string }>();
    if (this.isNative) {
      for (const d of await this.notif.getDownloads().catch(() => [])) {
        nativeById.set(String(d.id), d);
      }
    }

    for (const t of tasks) {
      if (this.isDesktop) {
        // Reconcile against the on-disk manifest: a file that survived is ready;
        // an interrupted download (no file) is failed so the user can retry.
        const hasLocal = await this.storage.has(`download-${t.mediaFileId}`);
        if (hasLocal) {
          if (t.status !== 'ready') this.updateTaskStatus(t.id, 'ready', 100);
        } else if (onStartup && t.status !== 'ready') {
          this.updateTaskStatus(t.id, 'failed', 0);
        }
        continue;
      }
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
      } else if (t.status === 'transcoding') {
        // In-flight when the app last stopped and stuck at 0% (web Shaka store
        // died with the JS context; a redeploy left the native download with a
        // dead session).
        if (onStartup) {
          // Cancel the dead native download so it can't keep retrying and race
          // the fresh one. Auto items are dropped and re-fetched by the
          // reconciler (one clean download); manual ones are flagged failed so
          // they don't silently vanish.
          if (t.auto) {
            await this.deleteDownload(t);
          } else {
            if (this.isNative) await this.notif.removeDownload(String(t.id));
            this.updateTaskStatus(t.id, 'failed', 0);
          }
        } else if (!this.isNative || !nativeById.has(String(t.id))) {
          this.updateTaskStatus(t.id, 'failed', 0);
        }
      }
    }

    this.recoveredAt.update((n) => n + 1);
  }
}
