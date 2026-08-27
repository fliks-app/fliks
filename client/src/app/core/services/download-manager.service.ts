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
import { DownloadSettingsService } from './download-settings.service';
import { ImageCacheService } from './image-cache.service';
import { ServerConfigService } from './server-config.service';
import { NetworkService } from './network.service';
import { imageUrlWithSize, type ImageSize } from '../pipes/resolve-url.pipe';
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
  private readonly imageCache = inject(ImageCacheService);
  /** Injected here so the native queue is capped from app start, before any
   *  download can be requested. */
  private readonly downloadSettings = inject(DownloadSettingsService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly network = inject(NetworkService);

  private readonly titles = new Map<number, { title: string; episode?: string }>();
  private eventSeq = 0;
  private nextLocalId = Date.now();

  // Web downloads each spin up a hidden player + Shaka store, so they honour
  // the same cap as the native queue; there the OS daemon enforces it instead.
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
    } else if (event.type === 'progress') {
      this.persistProgress(taskId, event.progress, event.state);
    }
    if (event.type !== 'progress') this.syncActivityCopy();
  });

  /** In-flight statuses, in the order a task moves through them. */
  private static readonly ACTIVE_STATUSES = ['transcoding', 'queued', 'downloading'];

  /** Last percentage persisted per task, so the write below can be throttled. */
  private readonly persistedProgress = new Map<number, number>();

  /** Promote the persisted status out of `transcoding` once the OS daemon has
   *  taken the task. {@link recover} keys off that distinction, so a task still
   *  reading `transcoding` after a relaunch looks like one that never started
   *  and gets cancelled. Progress is written in 5-point steps — the daemon emits
   *  it far more often than localStorage should be rewritten — but a change of
   *  state always lands, or a queued task would never show it left the queue. */
  private persistProgress(taskId: number, progress: number, state?: string) {
    const status = state === 'queued' ? 'queued' : 'downloading';
    const last = this.persistedProgress.get(taskId);
    const settled = this.cache.load().find((t) => t.id === taskId)?.status === status;
    if (settled && last !== undefined && progress - last < 5) return;
    this.persistedProgress.set(taskId, progress);
    this.updateTaskStatus(taskId, status, progress);
  }

  /**
   * Refresh the copy on the iOS Live Activity covering the download queue.
   *
   * The native side aggregates the numbers off its own task list — it is the
   * only thing that knows what is really transferring — but the wording has to
   * come from here: ngx-translate is the single source of copy and a widget
   * extension cannot reach it. Called whenever the batch changes shape, which
   * is the only time the wording can change.
   */
  private syncActivityCopy() {
    if (!this.isNative) return;
    const active = this.cache
      .load()
      .filter((t) => DownloadManagerService.ACTIVE_STATUSES.includes(t.status));
    if (!active.length) return;
    const only = active[0];
    const title = only.media?.title ?? '';
    this.notif.setActivityCopy({
      headline:
        active.length === 1
          ? (only.episodeLabel ? `${title} · ${only.episodeLabel}` : title)
          : this.translate.instant('downloads.notif_active_count', { count: active.length }),
      detail: this.translate.instant('downloads.notif_progress'),
      complete: this.translate.instant('downloads.notif_complete'),
      failed: this.translate.instant('downloads.notif_failed'),
    });
  }

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

  /** Reconcile again on reconnect. Rides the reachability signal rather than
   *  the DOM `online` event, which WKWebView never fires. */
  private readonly reconnectEffect = effect(() => {
    if (this.network.isOnline() && this.recoveredEpoch >= 0) void this.recover();
  });

  constructor() {
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
        notifProgress: this.translate.instant('downloads.notif_progress'),
        notifComplete: this.translate.instant('downloads.notif_complete'),
        notifFailed: this.translate.instant('downloads.notif_failed'),
      });
      this.syncActivityCopy();
    } else {
      this.enqueueWeb(task, hlsUrl);
    }

    return task;
  }

  /**
   * Run a failed download again from the metadata of the one that failed.
   *
   * The dead task is dropped first: its id is baked into the native daemon's
   * bookkeeping and into any partial bundle on disk, so reusing it would have
   * the retry inherit the corpse of the previous attempt.
   */
  async retryDownload(task: DownloadTask): Promise<DownloadTask> {
    await this.deleteDownload(task);
    return this.createDownload(
      task.mediaFileId,
      task.quality,
      task.media?.title ?? '',
      task.episodeLabel,
      {
        mediaId: task.mediaId,
        posterUrl: task.media?.posterUrl ?? null,
        type: task.media?.type,
        episodeId: task.episodeId,
        auto: task.auto,
      },
    );
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
    if (this.webActive < this.downloadSettings.maxConcurrent()) {
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
      let fanartUrl: string | null = null;
      try {
        const media = await this.mediaService.getOne(task.mediaId);
        fanartUrl = media.fanartUrl ?? null;
        const file = media.files?.find((f: any) => f.id === task.mediaFileId);
        const si = (file as any)?.streamInfo;
        if (si?.audio?.length > 1) {
          audioStreams = si.audio;
        }
      } catch { /* non-critical */ }

      this.prefetchArtwork(task.media?.posterUrl, fanartUrl);

      // Persist subtitle + audio metadata on the task
      const tasks = this.cache.load();
      this.cache.save(tasks.map((t) =>
        t.id === taskId ? { ...t, offlineSubtitles: offlineSubs, ...(audioStreams ? { audioStreams } : {}) } : t,
      ));
    } catch (e) {
      console.warn('[DL] Failed to pre-download subtitles:', e);
    }
  }

  /** Pin the title's artwork on disk alongside the media. The downloads page
   *  and the detail header still render it offline, where the remote URL is
   *  dead and the WebView cache is not something we control. */
  private prefetchArtwork(posterUrl?: string | null, fanartUrl?: string | null) {
    const wanted: [string | null | undefined, ImageSize][] = [
      [posterUrl, 'thumb'],
      [posterUrl, 'medium'],
      [fanartUrl, 'medium'],
    ];
    for (const [url, size] of wanted) {
      if (!url) continue;
      void this.imageCache.prefetch(this.serverConfig.resolveUrl(imageUrlWithSize(url, size)));
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
   * Re-sync one in-flight task with the native download daemon. Returns true
   * when the daemon still owns it — live or finished — and the caller must
   * leave it alone.
   *
   * `getDownloads` only reports transfers the daemon still holds (ExoPlayer
   * drops an item the moment it completes), so a download that finished while
   * the app was dead needs the `isDownloaded` probe, which reads the persistent
   * index on both platforms.
   */
  private async reconcileNative(
    task: DownloadTask,
    nativeById: Map<string, { id: string; progress: number; state: string }>,
  ): Promise<boolean> {
    const native = nativeById.get(String(task.id));
    if (native && native.state !== 'failed' && native.state !== 'removing') {
      if (native.state === 'completed') {
        this.updateTaskStatus(task.id, 'ready', 100);
        void this.preDownloadSubtitles(task.id);
      } else {
        this.persistedProgress.set(task.id, native.progress);
        this.updateTaskStatus(
          task.id,
          native.state === 'queued' ? 'queued' : 'downloading',
          native.progress,
        );
      }
      return true;
    }
    if (await this.notif.isDownloaded(String(task.id))) {
      this.updateTaskStatus(task.id, 'ready', 100);
      void this.preDownloadSubtitles(task.id);
      return true;
    }
    return false;
  }

  /**
   * Recover download state from localStorage cache.
   * Re-populates the titles map for UI display.
   *
   * `onStartup` = the app just (re)launched. That only condemns an in-flight
   * task on web and desktop, where the transfer lived in the JS context that
   * went away. On native the OS daemon owns it and outlives the process — iOS
   * even relaunches us in the background to deliver its session events — so
   * those are reconciled against the daemon instead.
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
      } else if (DownloadManagerService.ACTIVE_STATUSES.includes(t.status)) {
        // In-flight when the app last stopped. Ask the native daemon before
        // condemning anything — on web the Shaka store did die with the JS
        // context, but a native transfer very likely didn't.
        if (this.isNative && (await this.reconcileNative(t, nativeById))) continue;

        // Cancel the dead download so it can't keep retrying and race the fresh
        // one. Auto items are dropped and re-fetched by the reconciler (one
        // clean download); manual ones are flagged failed so they don't
        // silently vanish.
        if (onStartup && t.auto) {
          await this.deleteDownload(t);
        } else {
          if (this.isNative) await this.notif.removeDownload(String(t.id));
          this.updateTaskStatus(t.id, 'failed', 0);
        }
      }
    }

    this.recoveredAt.update((n) => n + 1);
  }
}
