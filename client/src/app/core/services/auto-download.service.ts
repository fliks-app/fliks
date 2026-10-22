import { Injectable, effect, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';
import { TvService } from './tv.service';
import { desktopDownloaderOrNull } from '../plugins/desktop-downloader.bridge';
import { AppResumeService } from './app-resume.service';
import { DownloadManagerService, episodeLabel } from './download-manager.service';
import { DownloadCacheService, DownloadTask } from './download-cache.service';
import { DownloadSettingsService } from './download-settings.service';
import { autoCapReached } from './auto-download-cap';
import { StreamingApiService } from './api/streaming-api.service';
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

/** Syncs offline downloads with the user's autoDownload playlists (native mobile and Electron, never TV or web): downloads unwatched items
 *  and removes auto-managed ones once watched; manual downloads are untouched. */
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
  private readonly settings = inject(DownloadSettingsService);
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
    const label = ep ? episodeLabel(ep.season?.seasonNumber ?? 0, ep.episodeNumber, ep.title) : undefined;
    return {
      mediaId: item.media.id,
      episodeId: ep?.id,
      title: item.media.title,
      episodeLabel: label,
      posterUrl: item.media.posterUrl,
      type: item.media.type,
      watched: item.watched,
    };
  }

  /** Download every not-yet-watched target that isn't already on-device, until the auto storage cap is reached. */
  private async downloadMissing(targets: AutoTarget[]): Promise<void> {
    const { started, failed } = await this.downloads.createMany(
      targets.filter((t) => !t.watched),
      this.settings.defaultQuality() || undefined,
      { auto: true, stop: () => autoCapReached(this.cache.load(), this.settings.autoCapGb()) },
    );
    this.log(`downloaded ${started}, failed ${failed}`);
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
}
