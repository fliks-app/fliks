import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { StreamingApiService } from './api/streaming-api.service';
import { NetworkService } from './network.service';
import { StorageScopeService } from './storage-scope.service';
import { AppResumeService } from './app-resume.service';
import { invalidatePrefix } from '../interceptors/cache.interceptor';

export interface PendingUpdate {
  mediaId: number;
  mediaFileId: number;
  episodeId?: number;
  positionSeconds: number;
  durationSeconds: number;
  /** Wall-clock of the last write. Lets a flush drop only what it actually
   *  sent, and orders an entry against the one that replaced it. */
  updatedAt: number;
}

const STORAGE_KEY = 'fliks.offline.pendingPlayback';
/** Last position this device played, synced or not. Survives a flush, unlike
 *  the queue, so an offline replay still knows where to resume. */
const LAST_KNOWN_KEY = 'fliks.offline.lastPlayback';
const LAST_KNOWN_MAX = 300;

function entryKey(mediaId: number, episodeId?: number): string {
  return `${mediaId}:${episodeId ?? ''}`;
}

/**
 * Playback positions this device recorded, and the queue of those the backend
 * hasn't accepted yet.
 *
 * Doubles as the local read model. Every progress read — continue-watching,
 * resume points, the offline player — otherwise comes back from the SWR cache
 * with the pre-offline value, so callers overlay {@link queuedPositionFor} (or
 * {@link overlayProgress}) on top of whatever the API returned.
 */
@Injectable({ providedIn: 'root' })
export class OfflinePlaybackSyncService {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly network = inject(NetworkService);
  private readonly scope = inject(StorageScopeService);
  private readonly appResume = inject(AppResumeService);

  private readonly _pending = signal<PendingUpdate[]>([]);
  /** Queued positions not yet accepted by the server. */
  readonly pending = this._pending.asReadonly();

  private readonly byKey = computed(() => {
    const map = new Map<string, PendingUpdate>();
    for (const p of this._pending()) map.set(entryKey(p.mediaId, p.episodeId), p);
    return map;
  });

  private flushing: Promise<void> | null = null;
  private rerun = false;

  constructor() {
    // Re-hydrate on login / logout / server switch — the queue is scoped like
    // the rest of the device-local state.
    effect(() => {
      this.scope.scope();
      this._pending.set(this.loadPending());
    });

    // Fires on construction too, which is the app-start flush: a queue stranded
    // by a kill while offline would otherwise sit there until the next
    // offline→online transition, and starting up online is not one.
    effect(() => {
      if (this.network.isOnline()) void this.flush();
    });

    // Reachability can recover with no status event of its own (server back up,
    // captive portal cleared) — a resume is the cheapest place to retry.
    this.appResume.resume$.subscribe(() => void this.flush());
  }

  /** Record a position the server hasn't got, and try to hand it over. */
  queue(update: Omit<PendingUpdate, 'updatedAt'>) {
    const entry = this.record(update);
    const key = entryKey(entry.mediaId, entry.episodeId);
    const next = this._pending().filter((p) => entryKey(p.mediaId, p.episodeId) !== key);
    next.push(entry);
    this.setPending(next);

    if (this.network.isOnline()) void this.flush();
  }

  /** Note a position the server already accepted. Not a sync candidate — it
   *  only keeps this device's resume points usable once the server goes out of
   *  reach. */
  record(update: Omit<PendingUpdate, 'updatedAt'>): PendingUpdate {
    const entry: PendingUpdate = {
      ...update,
      episodeId: update.episodeId ?? undefined,
      updatedAt: Date.now(),
    };
    const key = entryKey(entry.mediaId, entry.episodeId);
    const kept = this.loadLastKnown().filter((p) => entryKey(p.mediaId, p.episodeId) !== key);
    kept.push(entry);
    // Oldest first, so the cap drops the least recently played.
    kept.sort((a, b) => a.updatedAt - b.updatedAt);
    this.saveLastKnown(kept.slice(-LAST_KNOWN_MAX));
    return entry;
  }

  /** Position the server has not seen yet, or null. Overlay it on API reads:
   *  by construction it is newer than anything they can return. */
  queuedPositionFor(mediaId: number, episodeId?: number): PendingUpdate | null {
    return this.byKey().get(entryKey(mediaId, episodeId ?? undefined)) ?? null;
  }

  /** Layer queued positions over a server-sourced progress list. */
  overlayProgress<
    T extends {
      mediaId: number;
      episodeId: number | null;
      positionSeconds: number;
      durationSeconds: number;
      progressPercent: number;
    },
  >(items: T[]): T[] {
    const queued = this.byKey();
    if (!queued.size) return items;
    return items.map((item) => {
      const q = queued.get(entryKey(item.mediaId, item.episodeId ?? undefined));
      if (!q) return item;
      const durationSeconds = q.durationSeconds || item.durationSeconds;
      return {
        ...item,
        positionSeconds: q.positionSeconds,
        durationSeconds,
        progressPercent: durationSeconds
          ? Math.min(100, (q.positionSeconds / durationSeconds) * 100)
          : item.progressPercent,
      };
    });
  }

  /** Best resume point known without the server: the queued position if there
   *  is one, else the last one this device played. */
  resumePositionFor(mediaId: number, episodeId?: number): PendingUpdate | null {
    const queued = this.queuedPositionFor(mediaId, episodeId);
    if (queued) return queued;
    const key = entryKey(mediaId, episodeId ?? undefined);
    return this.loadLastKnown().find((p) => entryKey(p.mediaId, p.episodeId) === key) ?? null;
  }

  /** Push the queue to the server. Concurrency-safe: a call landing while a
   *  pass is running joins it and schedules exactly one more pass, so an entry
   *  queued mid-flush is neither stranded nor sent twice. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.rerun = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.rerun = false;
          await this.runFlush();
        } while (this.rerun);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async runFlush() {
    const pending = this._pending();
    if (!pending.length) return;

    const sent: PendingUpdate[] = [];
    for (const update of pending) {
      try {
        await this.streamingApi.updatePlaybackState(update.mediaId, {
          positionSeconds: update.positionSeconds,
          durationSeconds: update.durationSeconds,
          mediaFileId: update.mediaFileId,
          episodeId: update.episodeId,
        });
        sent.push(update);
      } catch {
        // Still unreachable — keep the rest for the next pass instead of
        // walking the whole queue into the same failure.
        break;
      }
    }
    if (!sent.length) return;

    // Filter the live queue, not the snapshot: queue() may have replaced an
    // entry while its PUT was in flight, and that newer position has to
    // survive.
    const sentByKey = new Map(sent.map((u) => [entryKey(u.mediaId, u.episodeId), u] as const));
    this.setPending(
      this._pending().filter((p) => {
        const s = sentByKey.get(entryKey(p.mediaId, p.episodeId));
        return !s || p.updatedAt > s.updatedAt;
      }),
    );

    // Continue-watching and the resume points come out of the SWR cache, which
    // still holds the positions we just superseded.
    await invalidatePrefix('/api/playback');
  }

  private read(key: string): PendingUpdate[] {
    try {
      const raw: PendingUpdate[] = JSON.parse(
        localStorage.getItem(`${key}.${this.scope.suffix()}`) ?? '[]',
      );
      return raw.map((p) => ({ ...p, updatedAt: p.updatedAt ?? 0 }));
    } catch {
      return [];
    }
  }

  private write(key: string, entries: PendingUpdate[]) {
    if (!this.scope.canPersist()) return;
    try {
      localStorage.setItem(`${key}.${this.scope.suffix()}`, JSON.stringify(entries));
    } catch {
      /* quota exceeded */
    }
  }

  private loadPending(): PendingUpdate[] {
    return this.read(STORAGE_KEY);
  }

  private setPending(pending: PendingUpdate[]) {
    this._pending.set(pending);
    this.write(STORAGE_KEY, pending);
  }

  private loadLastKnown(): PendingUpdate[] {
    return this.read(LAST_KNOWN_KEY);
  }

  private saveLastKnown(entries: PendingUpdate[]) {
    this.write(LAST_KNOWN_KEY, entries);
  }
}
