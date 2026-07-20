import { Injectable, effect, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';
import { TvService } from './tv.service';
import { desktopDownloaderOrNull } from '../plugins/desktop-downloader.bridge';
import { AppResumeService } from './app-resume.service';
import { DownloadManagerService } from './download-manager.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { StreamingApiService } from './api/streaming-api.service';
import { MediaService, Media } from './api/media.service';
import {
  PlaylistsApiService,
  PlaylistItem,
} from './api/playlists-api.service';

/** One thing an autoDownload playlist wants on-device. */
interface AutoTarget {
  mediaId: number;
  episodeId?: number;
  title: string;
  episodeLabel?: string;
  posterUrl: string | null;
  type: string;
  watched: boolean;
}

/**
 * Syncs offline downloads with the user's autoDownload playlists (native mobile
 * and the Electron desktop — never on TV or web). Downloads not-yet-watched
 * items that aren't on device and removes auto-managed downloads once watched;
 * manual downloads are never touched.
 */
@Injectable({ providedIn: 'root' })
export class AutoDownloadService {
  /** True on native mobile (iOS/Android) and the Electron desktop, where an
   *  offline backend exists. Also gates the settings toggle. */
  readonly enabled =
    (Capacitor.isNativePlatform() || !!desktopDownloaderOrNull()) &&
    !inject(TvService).isTv();
  private readonly auth = inject(AuthService);
  private readonly appResume = inject(AppResumeService);
  private readonly downloads = inject(DownloadManagerService);
  private readonly cache = inject(DownloadCacheService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly mediaService = inject(MediaService);
  private readonly playlistsApi = inject(PlaylistsApiService);

  private running = false;

  constructor() {
    if (!this.enabled) return;
    // Runs after the download manager recovers (auth-ready + reconnect); resume
    // and explicit changes (settings save / add) call reconcile() directly.
    effect(() => {
      if (this.downloads.recoveredAt() > 0) void this.reconcile('recovered');
    });
    this.appResume.resume$.subscribe(() => void this.reconcile('resume'));
  }

  private log(msg: string): void {
    console.info(`[auto-dl] ${msg}`);
  }

  // Auto-download is a per-device choice, so the flag lives in the app
  // (localStorage), keyed by playlist id — never on the server.
  private static readonly PREF_KEY = 'fliks.playlists.autoDownload';

  private prefs(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(AutoDownloadService.PREF_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  isAutoDownload(playlistId: number): boolean {
    return this.prefs()[playlistId] === true;
  }

  setAutoDownload(playlistId: number, enabled: boolean): void {
    const prefs = this.prefs();
    if (enabled) prefs[playlistId] = true;
    else delete prefs[playlistId];
    try {
      localStorage.setItem(AutoDownloadService.PREF_KEY, JSON.stringify(prefs));
    } catch {
      /* localStorage may be unavailable */
    }
  }

  /** Delete the matching auto-managed download as soon as an item is reported
   *  completed (player heartbeat), ahead of the next reconcile. */
  async onItemCompleted(mediaFileId: number): Promise<void> {
    if (!this.enabled || !mediaFileId) return;
    const task = this.cache
      .load()
      .find((t) => t.auto && t.mediaFileId === mediaFileId);
    if (task) {
      this.log(`item completed → deleting auto download for file ${mediaFileId}`);
      await this.downloads.deleteDownload(task);
    }
  }

  /** Enumerate autoDownload playlists, download what's missing, delete what's watched. */
  async reconcile(trigger = 'manual'): Promise<void> {
    if (!this.enabled) return;
    if (this.running) {
      this.log(`reconcile (${trigger}) skipped — already running`);
      return;
    }
    if (!this.auth.isAuthenticated()) return;
    this.running = true;
    this.log(`reconcile start (${trigger})`);
    try {
      const all = await this.playlistsApi.list({ force: true });
      // viewers can't act on the list, so skip those
      const playlists = all.filter(
        (p) => p.role !== 'viewer' && this.isAutoDownload(p.id),
      );
      this.log(
        `${all.length} playlist(s), ${playlists.length} with autoDownload`,
      );

      const targets = new Map<string, AutoTarget>();
      for (const p of playlists) {
        let items: PlaylistItem[];
        try {
          items = await this.playlistsApi.items(p.id, { force: true });
        } catch (err) {
          this.log(`items(${p.id}) failed: ${(err as Error).message}`);
          continue;
        }
        for (const item of items) {
          const key = `${item.media.id}:${item.episode?.id ?? 'movie'}`;
          if (targets.has(key)) continue;
          targets.set(key, this.toTarget(item));
        }
      }
      this.log(`${targets.size} distinct target(s)`);

      await this.deleteWatched();
      await this.downloadMissing([...targets.values()]);
      this.log(`reconcile done (${trigger})`);
    } catch (err) {
      // Best-effort background sync — log but never surface to the user.
      this.log(`reconcile (${trigger}) error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private toTarget(item: PlaylistItem): AutoTarget {
    const ep = item.episode;
    let episodeLabel: string | undefined;
    if (ep) {
      const s = ep.season?.seasonNumber ?? 0;
      episodeLabel =
        `S${String(s).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}` +
        (ep.title ? ` ${ep.title}` : '');
    }
    return {
      mediaId: item.media.id,
      episodeId: ep?.id,
      title: item.media.title,
      episodeLabel,
      posterUrl: item.media.posterUrl,
      type: item.media.type,
      watched: item.watched,
    };
  }

  /** Download every not-yet-watched target that isn't already on-device. */
  private async downloadMissing(targets: AutoTarget[]): Promise<void> {
    // one media fetch per series/movie, reused across its episodes
    const mediaCache = new Map<number, Media | null>();
    // sequential: paces session creation; the native daemon manages transfers
    for (const t of targets) {
      const label = t.episodeLabel ? `${t.title} ${t.episodeLabel}` : t.title;
      if (t.watched) continue;
      try {
        const fileId = await this.resolveFileId(t, mediaCache);
        if (!fileId) {
          this.log(`skip "${label}" — no downloadable file`);
          continue;
        }
        if (this.isOnDevice(fileId)) continue;
        const qualities = await this.streamingApi.getDownloadQualities(fileId);
        if (!qualities.length) {
          this.log(`skip "${label}" — no qualities for file ${fileId}`);
          continue;
        }
        this.log(`downloading "${label}" (file ${fileId}, ${qualities[0].key})`);
        await this.downloads.createDownload(
          fileId,
          qualities[0].key,
          t.title,
          t.episodeLabel,
          {
            mediaId: t.mediaId,
            posterUrl: t.posterUrl,
            type: t.type,
            episodeId: t.episodeId,
            auto: true,
          },
        );
      } catch (err) {
        this.log(`download "${label}" failed: ${(err as Error).message}`);
      }
    }
  }

  /** Remove auto-managed downloads the user has finished watching. */
  private async deleteWatched(): Promise<void> {
    const auto = this.cache.load().filter((t) => t.auto);
    if (!auto.length) return;

    const movies = auto.filter((t) => t.episodeId == null);
    const episodes = auto.filter((t) => t.episodeId != null);

    if (movies.length) {
      try {
        const watched = new Set(await this.streamingApi.getWatchedMediaIds());
        for (const t of movies) {
          if (watched.has(t.mediaId)) await this.downloads.deleteDownload(t);
        }
      } catch {
        /* offline / transient — retry next reconcile */
      }
    }

    // Episodes: one watched-ids lookup per distinct series.
    const bySeries = new Map<number, DownloadTask[]>();
    for (const t of episodes) {
      const list = bySeries.get(t.mediaId) ?? [];
      list.push(t);
      bySeries.set(t.mediaId, list);
    }
    for (const [seriesId, tasks] of bySeries) {
      try {
        const watched = new Set(
          await this.streamingApi.getWatchedEpisodeIds(seriesId),
        );
        for (const t of tasks) {
          if (t.episodeId != null && watched.has(t.episodeId)) {
            await this.downloads.deleteDownload(t);
          }
        }
      } catch {
        /* offline / transient — retry next reconcile */
      }
    }
  }

  /** The movie file or the episode's file, or null when there's none. */
  private async resolveFileId(
    t: AutoTarget,
    mediaCache: Map<number, Media | null>,
  ): Promise<number | null> {
    let media = mediaCache.get(t.mediaId);
    if (media === undefined) {
      media = await this.mediaService.getOne(t.mediaId).catch(() => null);
      mediaCache.set(t.mediaId, media);
    }
    if (!media) return null;
    const files = media.files ?? [];
    const file =
      t.episodeId != null
        ? files.find((f) => f.episodeId === t.episodeId)
        : (files.find((f) => f.episodeId == null) ?? files[0]);
    return file?.id ?? null;
  }

  /** True when a (non-failed) download for this file already exists. */
  private isOnDevice(mediaFileId: number): boolean {
    return this.cache
      .load()
      .some((t) => t.mediaFileId === mediaFileId && t.status !== 'failed');
  }
}
