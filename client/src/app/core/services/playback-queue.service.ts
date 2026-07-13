import { Injectable, computed, signal } from '@angular/core';

/** A single entry the player can navigate to. `mediaFileId` is resolved lazily
 *  (playlist items don't carry it), so it may be absent until the player is
 *  about to load the item. */
export interface QueueItem {
  mediaId: number;
  episodeId?: number;
  mediaFileId?: number;
  title: string;
  episodeTitle?: string;
  fanartUrl?: string | null;
  stillUrl?: string | null;
}

/** Where the active queue came from. Only playlists drive an explicit queue
 *  today; series "next episode" stays derived from the loaded media. */
export type QueueSource = 'playlist';

/**
 * Holds the active explicit playback queue that spans media boundaries (a
 * playlist). The player consumes it to decide what plays next and whether to
 * advance automatically. A launcher sets it right before navigating into the
 * player; the player clears it when it opens without a matching source, so a
 * standalone play never inherits a stale queue.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackQueueService {
  private readonly _items = signal<QueueItem[]>([]);
  private readonly _index = signal(0);
  private readonly _source = signal<QueueSource | null>(null);
  private readonly _sourceId = signal<number | null>(null);
  private readonly _autoplay = signal(false);

  /** True while a queue is driving playback. */
  readonly active = computed(() => this._items().length > 0);
  /** Id of the source that built the queue (e.g. the playlist id). */
  readonly sourceId = computed(() => this._sourceId());
  readonly source = computed(() => this._source());
  /** Whether the source wants back-to-back playback. */
  readonly autoplay = computed(() => this._autoplay());

  /** Begin a queue. `startIndex` is the item being launched. */
  start(
    items: QueueItem[],
    startIndex: number,
    opts: { source: QueueSource; sourceId: number; autoplay: boolean },
  ): void {
    this._items.set(items);
    this._index.set(Math.max(0, Math.min(startIndex, items.length - 1)));
    this._source.set(opts.source);
    this._sourceId.set(opts.sourceId);
    this._autoplay.set(opts.autoplay);
  }

  /** The item currently playing, per the cursor. */
  current(): QueueItem | null {
    return this._items()[this._index()] ?? null;
  }

  /** The item after the cursor, or null on the last item. */
  peekNext(): QueueItem | null {
    return this._items()[this._index() + 1] ?? null;
  }

  /** Move the cursor forward and return the new current item (or null). */
  advance(): QueueItem | null {
    if (this._index() >= this._items().length - 1) return null;
    this._index.update((i) => i + 1);
    return this.current();
  }

  /** Re-align the cursor to the item matching the given media/episode. Used by
   *  the player on launch so the cursor tracks the actually-loaded item even if
   *  the launcher's index and the URL ever diverge. */
  syncTo(mediaId: number, episodeId?: number): void {
    const idx = this._items().findIndex(
      (it) => it.mediaId === mediaId && (it.episodeId ?? null) === (episodeId ?? null),
    );
    if (idx >= 0) this._index.set(idx);
  }

  clear(): void {
    this._items.set([]);
    this._index.set(0);
    this._source.set(null);
    this._sourceId.set(null);
    this._autoplay.set(false);
  }
}
