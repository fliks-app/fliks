import { Injectable, inject, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService, type Media } from './api/media.service';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { embeddedSubtitleTag, embeddedSubtitleTitle, subtitleTrackKey } from '../utils/subtitle-tracks';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask, type OfflineSubtitle } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { TranslateService } from '@ngx-translate/core';
import { formatSubtitleLabel, offlineCropOf } from '../utils/player.utils';
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

/** Something to put on the device: a movie, or one episode of a series. */
export interface DownloadTarget {
  mediaId: number;
  episodeId?: number;
  /** Known file; resolved from the media when absent. */
  mediaFileId?: number;
  title: string;
  episodeLabel?: string;
  posterUrl: string | null;
  type: string;
}

/** `S01E02 Title`, the label stored on an episode download. */
export function episodeLabel(season: number, episode: number, title?: string | null): string {
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return title ? `${code} ${title}` : code;
}

/** Quality keys compare by height; `original` tops them all. */
const rungRank = (key: string) => (key === 'original' ? Infinity : parseInt(key, 10) || 0);

/** The wanted rung, else the best one below it, else the lowest on offer. */
export function pickRung<T extends { key: string }>(qualities: T[], key: string): T | undefined {
  const exact = qualities.find((q) => q.key === key);
  if (exact) return exact;
  const rank = rungRank(key);
  const byRank = [...qualities].sort((a, b) => rungRank(b.key) - rungRank(a.key));
  return byRank.find((q) => rungRank(q.key) <= rank) ?? byRank[byRank.length - 1];
}

/** Single entry point for downloads, fully client-side: ExoPlayer / AVAssetDownloadURLSession on native,
 *  Shaka offline storage on web, DownloadCacheService (localStorage) for UI tracking. */
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
      void this.persistSize(taskId);
    } else if (event.type === 'progress') {
      this.persistProgress(taskId, event.progress, event.state);
    }
    if (event.type !== 'progress') this.syncActivityCopy();
  });

  /** In-flight statuses, in the order a task moves through them. */
  private static readonly ACTIVE_STATUSES = ['transcoding', 'queued', 'downloading'];

  /** Last percentage persisted per task, so the write below can be throttled. */
  private readonly persistedProgress = new Map<number, number>();

  /** Promotes the persisted status out of `transcoding` once the OS daemon owns the task ({@link recover} would cancel it otherwise).
   *  Progress is written in 5-point steps to spare localStorage, but a state change always lands. */
  private persistProgress(taskId: number, progress: number, state?: string) {
    const status = state === 'queued' ? 'queued' : 'downloading';
    const last = this.persistedProgress.get(taskId);
    const settled = this.cache.load().find((t) => t.id === taskId)?.status === status;
    if (settled && last !== undefined && progress - last < 5) return;
    this.persistedProgress.set(taskId, progress);
    this.updateTaskStatus(taskId, status, progress);
  }

  /** Refreshes the copy on the iOS Live Activity covering the queue; the wording must come from here (ngx-translate, unreachable from the widget).
   *  An empty queue retires the card, the only reliable moment to clear one stranded by a force-quit. */
  private syncActivityCopy() {
    if (Capacitor.getPlatform() !== 'ios') return;
    const active = this.cache
      .load()
      .filter((t) => DownloadManagerService.ACTIVE_STATUSES.includes(t.status));
    if (!active.length) {
      this.notif.dismissActivity();
      return;
    }
    const only = active[0];
    const title = only.media?.title ?? '';
    this.notif.setActivityCopy({
      headline:
        active.length === 1
          ? (only.episodeLabel ? `${title} · ${only.episodeLabel}` : title)
          : this.translate.instant('downloads.notif_active_count', { count: active.length }),
      detail: this.translate.instant('downloads.notif_progress'),
      stale: this.translate.instant('downloads.notif_stale'),
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
      void this.persistSize(task.id);
    } else {
      this.updateTaskStatus(task.id, 'failed', 0);
      this.emitEvent('failed', task.id, 0);
    }
  }

  // ===== PUBLIC API =====

  /** Sequentially download each target not already on device, at `rungKey` when the file offers it, else the nearest lower rung
   *  (no key: the file's best). Failures are counted, not thrown, so one bad file doesn't stop the batch. */
  async createMany(
    targets: DownloadTarget[],
    rungKey?: string,
    opts?: { auto?: boolean; stop?: () => boolean },
  ): Promise<{ started: number; failed: number }> {
    const medias = new Map<number, Media | null>();
    let started = 0;
    let failed = 0;
    for (const t of targets) {
      if (opts?.stop?.()) break;
      try {
        const fileId = t.mediaFileId ?? (await this.resolveFileId(t, medias));
        if (!fileId || this.isOnDevice(fileId)) continue;
        const qualities = await this.streamingApi.getDownloadQualities(fileId);
        const quality = rungKey ? pickRung(qualities, rungKey) : qualities[0];
        if (!quality) continue;
        await this.createDownload(fileId, quality.key, t.title, t.episodeLabel, {
          mediaId: t.mediaId,
          posterUrl: t.posterUrl,
          type: t.type,
          episodeId: t.episodeId,
          auto: opts?.auto,
        });
        started++;
      } catch {
        failed++;
      }
    }
    return { started, failed };
  }

  private async resolveFileId(t: DownloadTarget, medias: Map<number, Media | null>): Promise<number | null> {
    let media = medias.get(t.mediaId);
    if (media === undefined) {
      media = await this.mediaService.getOne(t.mediaId).catch(() => null);
      medias.set(t.mediaId, media);
    }
    const files = media?.files ?? [];
    const file =
      t.episodeId != null
        ? files.find((f) => f.episodeId === t.episodeId)
        : (files.find((f) => f.episodeId == null) ?? files[0]);
    return file?.id ?? null;
  }

  /** True when a (non-failed) download for this file already exists. */
  private isOnDevice(mediaFileId: number): boolean {
    return this.cache.load().some((t) => t.mediaFileId === mediaFileId && t.status !== 'failed');
  }

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

    // Desktop keeps one offline copy per file (keyed by mediaFileId), so a new download replaces the prior one.
    if (this.isDesktop) {
      for (const prev of this.cache
        .load()
        .filter((t) => t.mediaFileId === mediaFileId)) {
        await this.deleteDownload(prev);
      }
    }

    // Fresh long-lived stream JWT before baking the URL into the daemon: downloads outlast the 1h access token.
    await this.auth.ensureStreamToken();

    // Desktop original: fetch the untouched container to disk via the raw ?download=1 route and play it with mpv; no HLS session.
    if (this.isDesktop && quality === 'original') {
      const url = this.streamingApi.getOriginalDownloadUrl(mediaFileId);
      task.hlsUrl = url;
      task.offlineEdl = await this.streamingApi.getEdl(mediaFileId).catch(() => []);
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

    // Live session as in playback: HLS segment routes resolve the codec variant from ?sid= and reject (410) without one.
    const playbackInfo = await this.streamingApi.getPlaybackInfo(
      mediaFileId,
      this.deviceProfile.getProfile(),
      undefined,
      undefined,
      quality,
      undefined,
      /* download */ true,
    );
    const hlsUrl = this.streamingApi.resolveDownloadUrl(mediaFileId, quality, playbackInfo);
    task.hlsUrl = hlsUrl;
    task.offlineCrop = offlineCropOf(playbackInfo);
    task.offlineEdl = playbackInfo.edl;

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
      // Pre-translated banner copy for the iOS notification (the native side never hardcodes text); ignored on Android.
      const notifTitle = episode ? `${title} · ${episode}` : title;
      this.notif.startDownload(String(taskId), hlsUrl, token, {
        notifTitle,
        notifProgress: this.translate.instant('downloads.notif_progress'),
        notifStale: this.translate.instant('downloads.notif_stale'),
        notifComplete: this.translate.instant('downloads.notif_complete'),
        notifFailed: this.translate.instant('downloads.notif_failed'),
      });
      this.syncActivityCopy();
    } else {
      this.enqueueWeb(task, hlsUrl);
    }

    return task;
  }

  /** Reruns a failed download from its metadata; the dead task is dropped first because its id lives in the daemon and any partial bundle. */
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

  /** Web offline download via Shaka's offline storage. */
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
        void this.persistSize(downloadId);
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
      const media = await this.mediaService.getOne(task.mediaId).catch(() => null);
      const si = (media?.files?.find((f: any) => f.id === task.mediaFileId) as any)?.streamInfo;
      const offlineSubs: OfflineSubtitle[] = [];
      for (const row of subs) {
        const sub = {
          ...row,
          title: embeddedSubtitleTitle(row, si?.subtitles),
          languageTag: embeddedSubtitleTag(row, si?.subtitles),
        };
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
          hearingImpaired: !!sub.hearingImpaired,
          codec: sub.codec,
          relativePath: sub.relativePath,
          providerType: sub.providerType,
          title: sub.title,
          languageTag: sub.languageTag,
          trackKey: subtitleTrackKey(sub)?.key,
        });
      }
      // Fetch audio stream info for offline audio track picker
      let audioStreams: { language?: string; languageTag?: string; title?: string; codec?: string; channels?: number }[] | undefined;
      let fanartUrl: string | null = null;
      fanartUrl = media?.fanartUrl ?? null;
      if (si?.audio?.length > 1) audioStreams = si.audio;

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

  /** Pins the artwork on disk so the downloads page and detail header render offline. */
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

  /** Measure what the finished download occupies and keep it on the task, so
   *  the list can show it without a per-row trip to the platform. */
  private async persistSize(taskId: number) {
    const task = this.cache.load().find((t) => t.id === taskId);
    if (!task) return;
    const bytes = await this.storage.sizeBytes(`download-${task.mediaFileId}`);
    if (!bytes) return;
    this.cache.save(
      this.cache.load().map((t) => (t.id === taskId ? { ...t, sizeBytes: bytes } : t)),
    );
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

  /** Re-syncs one in-flight task with the native daemon; true when it still owns the task (live or finished).
   *  `getDownloads` omits completed items (ExoPlayer drops them), so finished-while-dead needs the `isDownloaded` probe. */
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
        // Anything held but not transferring reads as queued (ExoPlayer also parks `stopped` / `restarting`).
        this.updateTaskStatus(
          task.id,
          native.state === 'downloading' ? 'downloading' : 'queued',
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

  /** Recovers download state from the localStorage cache.
   *  `onStartup` condemns an in-flight task only on web and desktop; on native the OS daemon outlives the process, so it is reconciled instead. */
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
        // Native: trust localStorage (DownloadIndex queries have timing issues); web: verify the Shaka URI exists.
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
        // In-flight at last stop: ask the native daemon first, since only web's Shaka store died with the JS context.
        if (this.isNative && (await this.reconcileNative(t, nativeById))) continue;

        // Cancel the dead download so it can't race the fresh one; auto items are re-fetched, manual ones flagged failed.
        if (onStartup && t.auto) {
          await this.deleteDownload(t);
        } else {
          if (this.isNative) await this.notif.removeDownload(String(t.id));
          this.updateTaskStatus(t.id, 'failed', 0);
        }
      }
    }

    // Downloads that finished before sizes were recorded, and any the
    // reconciliation above just promoted to ready.
    for (const t of this.cache.load()) {
      if (t.status === 'ready' && t.sizeBytes == null) void this.persistSize(t.id);
    }

    // Recovery has just decided what is really still going; a card describing
    // anything else — a queue a force-quit killed — goes now.
    this.syncActivityCopy();

    this.recoveredAt.update((n) => n + 1);
  }
}
