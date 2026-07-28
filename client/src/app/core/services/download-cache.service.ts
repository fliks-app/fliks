import { Injectable, signal, untracked, inject, effect } from '@angular/core';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';

/** Client-side download task tracked in localStorage. */
export interface DownloadTask {
  id: number;
  mediaId: number;
  episodeId?: number;
  mediaFileId: number;
  quality: string;
  status: string;
  progress: number;
  episodeLabel?: string;
  error?: string;
  /** Created by the auto-download reconciler from an autoDownload playlist.
   *  Only these are removed once watched — manual downloads are never touched. */
  auto?: boolean;
  createdAt: string;
  /** HLS URL used for the download — needed for native offline playback via CacheDataSource. */
  hlsUrl?: string;
  /** Pre-downloaded subtitle metadata for offline playback. */
  offlineSubtitles?: { key: string; language: string; label: string; forced?: boolean }[];
  /** Audio stream info for offline audio track picker. */
  audioStreams?: { language?: string; title?: string; codec?: string; channels?: number }[];
  media?: {
    id: number;
    title: string;
    posterUrl: string | null;
    type: string;
  };
}

const STORAGE_KEY = 'fliks.downloads.cache';
const LOCAL_IDS_KEY = 'fliks.downloads.localIds';

/**
 * Tracks device download progress (in-memory signals) and
 * persists task list for offline access (localStorage).
 *
 * Persistence is isolated per (server, user): a shared device never leaks one
 * account's downloads into another's list, and colliding mediaFileIds across
 * servers can't cross-surface.
 */
@Injectable({ providedIn: 'root' })
export class DownloadCacheService {
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);

  /** Active device downloads with progress % */
  readonly activeDownloads = signal<Map<number, number>>(new Map());

  /** Task IDs whose file is on device — persisted in localStorage */
  readonly localTaskIds = signal<Set<number>>(new Set());

  constructor() {
    // Re-hydrate on scope change (login / logout / server switch).
    effect(() => {
      this.auth.user();
      this.serverConfig.serverUrl();
      this.localTaskIds.set(this.loadLocalIds());
    });
  }

  /** No signed-in account means no scope to write into: a write between two
   *  sessions would land in a `::0` bucket nobody reads. */
  private canPersist(): boolean {
    return untracked(() => !!this.auth.user());
  }

  /** localStorage-key suffix isolating downloads to the current (server, user).
   *  Read untracked so it is safe to call from anywhere (including effects that
   *  also write localTaskIds) without creating a mutual-invalidation loop. */
  scopeSuffix(): string {
    return untracked(() => {
      const server = this.serverConfig.serverUrl();
      const userId = this.auth.user()?.id ?? 0;
      return `${server}::${userId}`;
    });
  }

  private storageKey(): string {
    return `${STORAGE_KEY}.${this.scopeSuffix()}`;
  }

  private localIdsKey(): string {
    return `${LOCAL_IDS_KEY}.${this.scopeSuffix()}`;
  }

  private loadLocalIds(): Set<number> {
    try {
      const raw = localStorage.getItem(this.localIdsKey());
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }

  private persistLocalIds() {
    if (!this.canPersist()) return;
    // untracked: markLocal/removeLocal run inside effects that also write
    // localTaskIds — a tracked read here would create a mutual-invalidation loop.
    localStorage.setItem(this.localIdsKey(), JSON.stringify([...untracked(() => this.localTaskIds())]));
  }

  markLocal(taskId: number) {
    this.localTaskIds.update((s) => new Set(s).add(taskId));
    this.persistLocalIds();
  }

  removeLocal(taskId: number) {
    this.localTaskIds.update((s) => { const n = new Set(s); n.delete(taskId); return n; });
    this.persistLocalIds();
  }

  isLocal(taskId: number): boolean {
    return this.localTaskIds().has(taskId);
  }

  markDownloading(taskId: number) {
    this.activeDownloads.update((m) => new Map(m).set(taskId, 0));
  }

  updateProgress(taskId: number, percent: number) {
    this.activeDownloads.update((m) => new Map(m).set(taskId, percent));
  }

  markDone(taskId: number) {
    this.activeDownloads.update((m) => {
      const next = new Map(m);
      next.delete(taskId);
      return next;
    });
  }

  isDownloading(taskId: number): boolean {
    return this.activeDownloads().has(taskId);
  }

  getProgress(taskId: number): number {
    return this.activeDownloads().get(taskId) ?? 0;
  }

  /** Persist task list for offline recovery */
  save(tasks: DownloadTask[]) {
    if (!this.canPersist()) return;
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(tasks));
    } catch {
      // quota exceeded
    }
  }

  /** Load cached task list (for offline) */
  load(): DownloadTask[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  has(taskId: number): boolean {
    return this.isDownloading(taskId) || this.load().some((t) => t.id === taskId);
  }

  remove(taskId: number) {
    const tasks = this.load().filter((t) => t.id !== taskId);
    this.save(tasks);
  }
}
