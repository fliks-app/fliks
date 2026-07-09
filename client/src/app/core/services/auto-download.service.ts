import { Injectable, effect, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';
import { TvService } from './tv.service';
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
 * Keeps offline downloads in sync with the user's autoDownload playlists.
 *
 * Native mobile only (iOS/Android): TVs and the web app never auto-download —
 * TV offline storage is unavailable and the web path would spin up a hidden
 * player per item. Guarded by the same `native && !TV` gate the /downloads
 * flow uses.
 *
 * Reconciles on auth-ready, on reconnect, on app resume, and whenever a
 * playlist's autoDownload setting is saved. Each pass downloads any
 * not-yet-watched item of an autoDownload playlist that isn't already
 * on-device, and (auto-delete-after-watched) removes any auto-managed download
 * the user has since finished. Manual downloads are never touched.
 */
@Injectable({ providedIn: 'root' })
export class AutoDownloadService {
  private readonly enabled =
    Capacitor.isNativePlatform() && !inject(TvService).isTv();
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
    // Reconcile once auth is ready and again on every event that could have
    // changed the desired set while we weren't looking.
    effect(() => {
      if (this.auth.isAuthenticated()) void this.reconcile('auth');
    });
    window.addEventListener('online', () => void this.reconcile('online'));
    this.appResume.resume$.subscribe(() => void this.reconcile('resume'));
  }

  private log(msg: string): void {
    console.info(`[auto-dl] ${msg}`);
  }

  /**
   * Delete the matching auto-managed download the moment an item is reported
   * completed (from the player's heartbeat), rather than waiting for the next
   * reconcile. Manual downloads (auto !== true) are left in place.
   */
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
      const playlists = all.filter(
        // A viewer can't act on the list, so never auto-download on their behalf.
        (p) => p.autoDownload && p.role !== 'viewer',
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
    // One media fetch per series/movie, reused across its episodes this pass.
    const mediaCache = new Map<number, Media | null>();
    // Sequential on purpose: paces session creation and lets the native
    // download daemon manage its own transfer concurrency.
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

  /** Resolve the media file to download for a target (movie file or the
   *  episode's file), or null when the media has no file to offer. */
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
