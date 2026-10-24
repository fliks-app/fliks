import { Injectable, inject, computed, effect, signal, type Signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { MediaService, type Media } from './api/media.service';
import { isImageBasedSubtitleCodec } from '../utils/subtitle-codecs';
import { embeddedSubtitleTag, embeddedSubtitleTitle, subtitleTrackKey } from '../utils/subtitle-tracks';
import { OfflineStorageService } from './offline-storage.service';
import { DownloadCacheService, DownloadTask, type OfflineSubtitle } from './download-cache.service';
import { DownloadNotificationService, type NativeDownloadEvent } from './download-notification.service';
import { heldStatus, isActive, type DownloadStatus } from './download-status';
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

/** Something to put on the device: a movie, or one episode of a series. */
export interface DownloadTarget {
  mediaId: number;
  episodeId?: number;
  /** Known file; resolved from the media when absent. */
  mediaFileId?: number;
  title: string;
  episodeLabel?: string;
  seasonNumber?: number;
  episodeNumber?: number;
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
  private nextLocalId = Date.now();

  // Web downloads each spin up a hidden player + Shaka store, so they honour
  // the same cap as the native queue; there the OS daemon enforces it instead.
  private webActive = 0;
  private readonly webQueue: Array<() => void> = [];

  /** The persisted task list, the one source every reader derives from; a task being deleted is already gone. */
  readonly tasks: Signal<DownloadTask[]> = computed(() => {
    const deleting = this.deleting();
    const tasks = this.cache.tasks();
    return deleting.size ? tasks.filter((t) => !deleting.has(t.id)) : tasks;
  });

  /** Bumped when {@link recover} finishes, so the auto-download reconciler runs
   *  after interrupted tasks are cleaned up instead of racing that pass. */
  readonly recoveredAt = signal(0);

  /** Ids mid-{@link deleteDownload}, so the native `removed` echo of our own removal isn't deleted twice. */
  private readonly deleting = signal<ReadonlySet<number>>(new Set());

  // --- Native: ExoPlayer DownloadManager events ---
  // The bridge only emits on native, and gates its own calls, so neither needs a platform check here.
  private readonly nativeSub = this.notif.nativeEvents.subscribe((event) => this.onNativeEvent(event));

  private onNativeEvent(event: NativeDownloadEvent) {
    const taskId = Number(event.id) || 0;
    if (event.type === 'failed') {
      this.updateTaskStatus(taskId, 'failed', 0);
    } else if (event.type === 'complete') {
      this.updateTaskStatus(taskId, 'ready', 100);
      // Pre-download subtitles for offline playback (fire-and-forget)
      void this.preDownloadSubtitles(taskId);
      void this.persistSize(taskId);
    } else if (event.type === 'removed') {
      const task = this.cache.load().find((t) => t.id === taskId);
      if (task && !this.deleting().has(taskId)) void this.deleteDownload(task);
    } else {
      this.persistProgress(taskId, event.progress, event.state);
    }
    if (event.type !== 'progress') this.syncActivityCopy();
  }

  /** Promotes the persisted status out of `preparing` once the OS daemon owns the task ({@link recover} would cancel it otherwise). */
  private persistProgress(taskId: number, progress: number, state?: string) {
    if (this.cache.load().find((t) => t.id === taskId)?.status === 'ready') return;
    this.updateTaskStatus(taskId, heldStatus(state) ?? 'downloading', progress);
  }

  /** Hands the Android notifications their wording; native persists it, so a restarted service keeps the language. */
  private syncNotificationCopy() {
    const t = (key: string, params?: object) => this.translate.instant(`downloads.${key}`, params);
    this.notif.setNotificationCopy({
      channelName: t('notif_channel_name'),
      channelDescription: t('notif_channel_description'),
      progress: t('notif_progress'),
      paused: t('notif_paused'),
      complete: t('notif_complete'),
      failed: t('notif_failed'),
      activeCount: t('notif_active_count', { count: '%d' }),
      timeLeft: t('notif_time_left', { time: '%s' }),
      pause: t('notif_pause'),
      resume: t('notif_resume'),
      cancel: t('notif_cancel'),
      waitingWifi: t('notif_waiting_wifi'),
    });
  }

  /** Refreshes the copy on the iOS Live Activity covering the queue; the wording must come from here (ngx-translate, unreachable from the widget).
   *  An empty queue retires the card, the only reliable moment to clear one stranded by a force-quit. */
  private syncActivityCopy() {
    this.syncNotificationCopy();
    if (Capacitor.getPlatform() !== 'ios') return;
    const active = this.cache
      .load()
      .filter((t) => isActive(t.status));
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

  /** Map a desktop (Electron) download status event onto the in-flight task it names (the desktop id is the task id).
   *  Progress drives the badge; done pre-fetches subtitles. */
  private onDesktopStatus(s: DesktopDownloadStatus): void {
    const task = this.cache.load().find((t) => String(t.id) === s.id && isActive(t.status));
    if (!task) return;
    if (s.state === 'progress') {
      const pct = s.total > 0 ? Math.round((s.received / s.total) * 100) : 0;
      this.updateTaskStatus(task.id, task.status === 'paused' ? 'paused' : 'downloading', pct);
    } else if (s.state === 'paused') {
      return;
    } else if (s.state === 'done') {
      this.updateTaskStatus(task.id, 'ready', 100);
      void this.preDownloadSubtitles(task.id);
      void this.persistSize(task.id);
    } else {
      this.updateTaskStatus(task.id, 'failed', 0);
    }
  }

  // ===== PUBLIC API =====

  /** Held web downloads: Shaka's request filter awaits the gate, so stored segments survive while the tab lives. */
  private readonly webGates = new Map<number, { promise: Promise<void>; open: () => void }>();

  // State is set before the platform call, so a native event raised during the call lands after it.
  async pauseDownload(task: DownloadTask): Promise<void> {
    this.updateTaskStatus(task.id, 'paused', task.progress);
    if (this.isDesktop) {
      await this.downloader!.pause(String(task.id));
    } else if (this.isNative) {
      await this.notif.pauseDownload(String(task.id));
    } else if (!this.webGates.has(task.id)) {
      let open!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      this.webGates.set(task.id, { promise, open });
    }
  }

  async resumeDownload(task: DownloadTask): Promise<void> {
    if (this.isDesktop && !task.hlsUrl) return;
    this.updateTaskStatus(task.id, 'downloading', task.progress);
    if (this.isDesktop) {
      // Main keeps no paused state: a fresh start skips what is already on disk.
      void this.downloader!.start({
        id: String(task.id),
        url: task.hlsUrl!,
        quality: task.quality,
        filename: task.episodeLabel ? `${task.media?.title} - ${task.episodeLabel}` : (task.media?.title ?? ''),
      });
    } else if (this.isNative) {
      await this.notif.resumeDownload(String(task.id));
    } else {
      this.webGates.get(task.id)?.open();
      this.webGates.delete(task.id);
    }
  }

  /** Sequentially download each target not already on device, at `rungKey` when the file offers it, else the nearest lower rung
   *  (no key: the file's best). Failures are counted, not thrown, so one bad file doesn't stop the batch. */
  async createMany(
    targets: DownloadTarget[],
    rungKey?: string,
    opts?: { auto?: boolean; stop?: () => boolean },
  ): Promise<{ started: number; failed: number; skipped: number }> {
    const medias = new Map<number, Media | null>();
    let started = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of targets) {
      if (opts?.stop?.()) break;
      try {
        const fileId = t.mediaFileId ?? (await this.resolveFileId(t, medias));
        if (!fileId) continue;
        if (this.isOnDevice(fileId)) {
          skipped++;
          continue;
        }
        const qualities = await this.streamingApi.getDownloadQualities(fileId);
        const quality = rungKey ? pickRung(qualities, rungKey) : qualities[0];
        if (!quality) continue;
        await this.createDownload(fileId, quality.key, t.title, t.episodeLabel, {
          mediaId: t.mediaId,
          posterUrl: t.posterUrl,
          type: t.type,
          episodeId: t.episodeId,
          seasonNumber: t.seasonNumber,
          episodeNumber: t.episodeNumber,
          auto: opts?.auto,
        });
        started++;
      } catch {
        failed++;
      }
    }
    return { started, failed, skipped };
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
  isOnDevice(mediaFileId: number): boolean {
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
      seasonNumber?: number;
      episodeNumber?: number;
      /** Set by the auto-download reconciler; enables auto-delete-after-watched. */
      auto?: boolean;
    },
  ): Promise<DownloadTask> {
    const taskId = this.nextLocalId++;
    const task: DownloadTask = {
      id: taskId,
      mediaId: meta?.mediaId ?? 0,
      episodeId: meta?.episodeId,
      seasonNumber: meta?.seasonNumber,
      episodeNumber: meta?.episodeNumber,
      mediaFileId,
      quality,
      status: 'preparing',
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
        id: String(taskId),
        url,
        filename: episode ? `${title} - ${episode}` : title,
      });
      this.updateTaskStatus(taskId, 'downloading', 0);
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
    task.sessionId = playbackInfo.sessionId;
    task.offlineCrop = offlineCropOf(playbackInfo);
    task.offlineEdl = playbackInfo.edl;

    this.titles.set(taskId, { title, episode });
    this.persistTask(task);

    if (this.isDesktop) {
      // Desktop, transcoded rung: mirror the HLS bundle to disk and play it
      // offline via mpv (the local master.m3u8) — like the native offline flow.
      void this.downloader!.start({
        id: String(taskId),
        url: hlsUrl,
        quality,
        filename: episode ? `${title} - ${episode}` : title,
      });
      this.updateTaskStatus(taskId, 'downloading', 0);
    } else if (this.isNative) {
      const token =
        this.auth.streamToken() ?? this.auth.accessToken ?? '';
      // Pre-translated copy: the native side never hardcodes text.
      this.syncNotificationCopy();
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
        seasonNumber: task.seasonNumber,
        episodeNumber: task.episodeNumber,
        auto: task.auto,
      },
    );
  }

  async deleteDownload(task: DownloadTask) {
    this.deleting.update((s) => new Set(s).add(task.id));
    try {
      this.webGates.get(task.id)?.open();
      this.webGates.delete(task.id);
      await this.notif.removeDownload(String(task.id));
      if (task.sessionId) this.streamingApi.stopSession(task.sessionId).catch(() => {});
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
      this.titles.delete(task.id);
    } finally {
      this.deleting.update((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
    }
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

    const offlineUri = this.storage.getShakaOfflineUri(task.mediaFileId);
    if (offlineUri) {
      return;
    }

    const info = this.titles.get(downloadId);
    const title = info?.title ?? task.media?.title ?? 'Download';
    this.updateTaskStatus(downloadId, 'downloading', 0);

    try {
      const storedUri = await this.storage.shakaStore(
        hlsUrl,
        task.mediaFileId,
        { title, episode: info?.episode },
        () => this.webGates.get(downloadId)?.promise,
        (progress) => {
          const pct = Math.round(progress * 100);
          const held = this.cache.load().find((t) => t.id === downloadId)?.status === 'paused';
          this.updateTaskStatus(downloadId, held ? 'paused' : 'downloading', pct);
        },
      );

      if (storedUri) {
        this.updateTaskStatus(downloadId, 'ready', 100);
        void this.preDownloadSubtitles(downloadId);
        void this.persistSize(downloadId);
      } else {
        throw new Error('Shaka offline store returned null');
      }
    } catch (err) {
      console.error('[DL] Shaka offline store failed:', err);
      this.updateTaskStatus(downloadId, 'failed', 0);
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

      const logoUrl = media?.logoUrl ?? null;
      this.prefetchArtwork(task.media?.posterUrl, fanartUrl, logoUrl);

      // Persist subtitle + audio metadata on the task
      const tasks = this.cache.load();
      this.cache.save(tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              offlineSubtitles: offlineSubs,
              ...(audioStreams ? { audioStreams } : {}),
              ...(t.media ? { media: { ...t.media, logoUrl } } : {}),
            }
          : t,
      ));
    } catch (e) {
      console.warn('[DL] Failed to pre-download subtitles:', e);
    }
  }

  /** Pins the artwork on disk so the downloads page and detail header render offline. */
  private prefetchArtwork(posterUrl?: string | null, fanartUrl?: string | null, logoUrl?: string | null) {
    const wanted: [string | null | undefined, ImageSize][] = [
      [posterUrl, 'thumb'],
      [posterUrl, 'medium'],
      [fanartUrl, 'medium'],
      [logoUrl, 'medium'],
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

  /** The signal updates on every call; a repeated in-flight status only trails its localStorage write. */
  private updateTaskStatus(taskId: number, status: DownloadStatus, progress: number) {
    const tasks = this.cache.load();
    const current = tasks.find((t) => t.id === taskId);
    if (!current) return;
    const lazy = current.status === status && isActive(status);
    const settledSid = status === 'ready' || status === 'failed' ? current.sessionId : undefined;
    const next = { ...current, status, progress, ...(settledSid && { sessionId: undefined }) };
    this.cache.save(tasks.map((t) => (t === current ? next : t)), lazy);
    if (settledSid) this.streamingApi.stopSession(settledSid).catch(() => {});
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
        // Anything held but not transferring reads as queued (ExoPlayer also parks `stopped` / `restarting`).
        this.updateTaskStatus(
          task.id,
          heldStatus(native.state) ?? (native.state === 'downloading' ? 'downloading' : 'queued'),
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
          }
        }
      } else if (t.status === 'failed') {
        // Remove stale failed tasks
        this.cache.remove(t.id);
      } else if (isActive(t.status)) {
        // In-flight at last stop: ask the native daemon first, since only web's Shaka store died with the JS context.
        if (this.isNative && (await this.reconcileNative(t, nativeById))) continue;

        // Cancel the dead download so it can't race the fresh one; auto items are re-fetched, manual ones flagged failed.
        if (onStartup && t.auto) {
          await this.deleteDownload(t);
        } else {
          await this.notif.removeDownload(String(t.id));
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
