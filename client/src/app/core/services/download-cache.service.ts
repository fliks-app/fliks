import { Injectable, signal, untracked, inject, effect } from '@angular/core';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { StorageScopeService } from './storage-scope.service';
import type { OfflineCrop } from '../utils/player.utils';
import type { EdlRange } from '../utils/edl-policy';
import { normalizeStatus, type DownloadStatus } from './download-status';

/** Client-side download task tracked in localStorage. */
export interface OfflineSubtitle {
  key: string;
  language: string;
  label: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  codec?: string | null;
  relativePath?: string | null;
  providerType?: string | null;
  /** Embedded stream title; absent on downloads saved before it was kept. */
  title?: string | null;
  /** Embedded stream BCP-47 tag; absent on downloads saved before it was kept. */
  languageTag?: string | null;
  trackKey?: string;
}

export interface DownloadTask {
  id: number;
  mediaId: number;
  episodeId?: number;
  mediaFileId: number;
  quality: string;
  status: DownloadStatus;
  progress: number;
  episodeLabel?: string;
  /** Absent on tasks saved before they were kept; the grouping parses `episodeLabel` then. */
  seasonNumber?: number;
  episodeNumber?: number;
  error?: string;
  /** Created by the auto-download reconciler from an autoDownload playlist.
   *  Only these are removed once watched — manual downloads are never touched. */
  auto?: boolean;
  createdAt: string;
  /** HLS URL used for the download — needed for native offline playback via CacheDataSource. */
  hlsUrl?: string;
  /** The pinned server session the transfer runs on, released once the task settles. */
  sessionId?: string;
  /** Bytes the finished download occupies on device, measured once it lands (mid-transfer figures are the part received). */
  sizeBytes?: number;
  /** Pre-downloaded subtitle metadata for offline playback. `trackKey` is the online id (`emb-<streamIndex>` / `ext-<id>`);
   *  older tasks lack it, and before the descriptors only `label` describes the track. */
  offlineSubtitles?: OfflineSubtitle[];
  /** Letterbox rectangle the player removes at playback; absent when the copy was cropped server-side. */
  offlineCrop?: OfflineCrop;
  /** `.edl` ranges captured at download time, on the playback clock of the stored copy. */
  offlineEdl?: EdlRange[];
  /** Audio stream info for offline audio track picker. */
  audioStreams?: { language?: string; languageTag?: string; title?: string; codec?: string; channels?: number }[];
  media?: {
    id: number;
    title: string;
    posterUrl: string | null;
    type: string;
    /** Title logo, kept so the offline player header has it. */
    logoUrl?: string | null;
  };
}

const STORAGE_KEY = 'fliks.downloads.cache';
/** Progress ticks reach the signal at once; the localStorage write trails by this much. */
const PERSIST_DELAY_MS = 1000;

/** The device's download list: one `tasks` signal, persisted (localStorage) and isolated per (server, user)
 *  so shared devices and colliding mediaFileIds never cross-surface. */
@Injectable({ providedIn: 'root' })
export class DownloadCacheService {
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly scope = inject(StorageScopeService);

  private readonly _tasks = signal<DownloadTask[]>(this.read());
  readonly tasks = this._tasks.asReadonly();

  private hydratedKey = this.storageKey();
  private pending: { key: string; tasks: DownloadTask[] } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-hydrate on scope change (login / logout / server switch).
    effect(() => {
      this.auth.user();
      this.serverConfig.serverUrl();
      untracked(() => {
        const key = this.storageKey();
        if (key === this.hydratedKey) return;
        this.flush();
        this.hydratedKey = key;
        this._tasks.set(this.read());
      });
    });
  }

  /** localStorage-key suffix isolating downloads to the current (server, user). */
  scopeSuffix(): string {
    return this.scope.suffix();
  }

  private storageKey(): string {
    return `${STORAGE_KEY}.${this.scopeSuffix()}`;
  }

  private read(): DownloadTask[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      const list: DownloadTask[] = raw ? JSON.parse(raw) : [];
      return list.map((t) => ({ ...t, status: normalizeStatus(t.status) }));
    } catch {
      return [];
    }
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (!p || !this.scope.canPersist()) return;
    try {
      localStorage.setItem(p.key, JSON.stringify(p.tasks));
    } catch {
      // quota exceeded
    }
  }

  /** Replaces the list. `lazy` (progress ticks) trails the localStorage write; the signal is never delayed. */
  save(tasks: DownloadTask[], lazy = false) {
    this._tasks.set(tasks);
    this.pending = { key: this.storageKey(), tasks };
    if (!lazy) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), PERSIST_DELAY_MS);
  }

  /** Current list, untracked; read `tasks` in a computed or effect to react. */
  load(): DownloadTask[] {
    return untracked(this._tasks);
  }

  remove(taskId: number) {
    this.save(this.load().filter((t) => t.id !== taskId));
  }
}
