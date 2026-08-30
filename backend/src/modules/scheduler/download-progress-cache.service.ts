import { Injectable, Optional } from '@nestjs/common';
import type { SseEvent } from './events.service';

type DownloadProgressEvent = Extract<SseEvent, { type: 'download.progress' }>;

interface CachedLeaf {
  event: DownloadProgressEvent;
  recipients: readonly number[];
  recordedAt: number;
}

// `CompletionService.processCompleted` re-emits every in-flight download once
// a minute — a leaf that has gone this many ticks without a refresh didn't
// just miss one slow tick, it left the download client (stalled-removed,
// user-deleted, media deleted, …) through a path that never reaches
// `import.complete`. 3x the cron interval absorbs one skipped/slow tick
// without misfiring, while still self-healing within a few minutes instead
// of holding a phantom leaf for the life of the process.
const STALE_AFTER_MS = 3 * 60_000;

/**
 * In-memory replay cache for `download.progress`: the publisher can tick as
 * slowly as once a minute, so without this a client that connects between
 * ticks sees nothing until the next one. Mirrors `PluginCountsCacheService`'s
 * shape — not persisted, a restart is a legitimate reset. `import.complete`
 * evicts a leaf immediately (the fast path); the age check in `snapshotFor`
 * is the backstop catch-all for every other way a download stops — it needs
 * no list of end-events and self-heals on the next connect, no sweep timer.
 */
@Injectable()
export class DownloadProgressCacheService {
  private readonly leaves = new Map<string, CachedLeaf>();

  constructor(@Optional() private readonly now: () => number = Date.now) {}

  /** Leaf count — lets a caller (test) confirm the staleness sweep actually
   *  frees memory instead of merely filtering the same leaf on every read. */
  get size(): number {
    return this.leaves.size;
  }

  private key(e: DownloadProgressEvent): string {
    return `${e.mediaId}:${e.seasonNumber ?? ''}:${e.episodeNumber ?? ''}:${e.ref ?? ''}`;
  }

  /** Record the latest push for its recipients. A leaf reporting done
   *  (`progress >= 1`) is dropped rather than replayed as "100% done". */
  record(recipients: readonly number[], event: DownloadProgressEvent): void {
    const key = this.key(event);
    if (event.progress >= 1) {
      this.leaves.delete(key);
      return;
    }
    this.leaves.set(key, { event, recipients, recordedAt: this.now() });
  }

  /** Retire every cached leaf for a media (or just one season/episode within
   *  it) — mirrors the client's own `clearMedia`, called on `import.complete`. */
  clear(mediaId: number, seasonNumber?: number, episodeNumber?: number): void {
    for (const [key, leaf] of this.leaves) {
      if (leaf.event.mediaId !== mediaId) continue;
      if (seasonNumber != null && leaf.event.seasonNumber !== seasonNumber) continue;
      if (episodeNumber != null && leaf.event.episodeNumber !== episodeNumber) continue;
      this.leaves.delete(key);
    }
  }

  /** Every cached leaf this user was a recipient of — replayed on SSE connect.
   *  Walks every leaf (not just this user's) so a stale one is deleted here
   *  regardless of which user's connect happened to trigger the check. */
  snapshotFor(userId: number): DownloadProgressEvent[] {
    const cutoff = this.now() - STALE_AFTER_MS;
    const out: DownloadProgressEvent[] = [];
    for (const [key, leaf] of this.leaves) {
      if (leaf.recordedAt < cutoff) {
        this.leaves.delete(key);
        continue;
      }
      if (leaf.recipients.includes(userId)) out.push(leaf.event);
    }
    return out;
  }
}
