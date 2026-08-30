import { Injectable, Optional } from '@nestjs/common';
import type { SseEvent } from './events.service';

type DownloadProgressEvent = Extract<SseEvent, { type: 'download.progress' }>;

interface CachedMedia {
  event: DownloadProgressEvent;
  recipients: readonly number[];
  recordedAt: number;
}

// The publisher re-states every in-flight media about once a minute. A media that has gone this
// many ticks without a refresh is one whose publisher died or was reconfigured, not one that was
// slow: 3x the cron interval absorbs a skipped tick while still self-healing in a few minutes.
//
// It is a memory bound and a backstop, not the removal mechanism: a download that stops is gone
// from the very next snapshot, because a snapshot states the whole set.
const STALE_AFTER_MS = 3 * 60_000;

/**
 * In-memory replay cache for `download.progress`, one entry per media. The publisher can tick as
 * slowly as once a minute, so without this a client connecting between ticks sees nothing until
 * the next one. Not persisted; a restart is a legitimate reset.
 *
 * Each entry holds a whole snapshot, so recording is a replacement and there is nothing to
 * reconcile: the shape that made a phantom leaf possible is gone rather than guarded.
 */
@Injectable()
export class DownloadProgressCacheService {
  private readonly media = new Map<number, CachedMedia>();

  constructor(@Optional() private readonly now: () => number = Date.now) {}

  /** Media count — lets a caller (test) confirm the staleness sweep actually frees memory
   *  instead of merely filtering the same entry on every read. */
  get size(): number {
    return this.media.size;
  }

  /** The last snapshot for a media, for a caller adding to it rather than replacing it. */
  current(mediaId: number): DownloadProgressEvent | undefined {
    return this.media.get(mediaId)?.event;
  }

  /** Record the latest snapshot. An empty one says the media has nothing in flight, which is
   *  the same statement as having no entry at all. */
  record(recipients: readonly number[], event: DownloadProgressEvent): void {
    if (!event.downloads.length) {
      this.media.delete(event.mediaId);
      return;
    }
    this.media.set(event.mediaId, { event, recipients, recordedAt: this.now() });
  }

  /** Retire a media's cached downloads (or just one season/episode within it) — the fast path
   *  on `import.complete`, ahead of the publisher's next snapshot. */
  clear(mediaId: number, seasonNumber?: number, episodeNumber?: number): void {
    const entry = this.media.get(mediaId);
    if (!entry) return;
    if (seasonNumber == null) {
      this.media.delete(mediaId);
      return;
    }
    const downloads = entry.event.downloads.filter((d) => {
      if (d.seasonNumber !== seasonNumber) return true;
      // Narrower than the season filter: a download naming no episode is a pack, which one
      // episode's import does not finish.
      return episodeNumber != null && d.episodeNumber !== episodeNumber;
    });
    if (!downloads.length) this.media.delete(mediaId);
    else this.media.set(mediaId, { ...entry, event: { ...entry.event, downloads } });
  }

  /** Every cached snapshot this user was a recipient of — replayed on SSE connect. Walks every
   *  entry (not just this user's) so a stale one is dropped here regardless of which user's
   *  connect happened to trigger the check. */
  snapshotFor(userId: number): DownloadProgressEvent[] {
    const cutoff = this.now() - STALE_AFTER_MS;
    const out: DownloadProgressEvent[] = [];
    for (const [mediaId, entry] of this.media) {
      if (entry.recordedAt < cutoff) {
        this.media.delete(mediaId);
        continue;
      }
      if (entry.recipients.includes(userId)) out.push(entry.event);
    }
    return out;
  }
}
