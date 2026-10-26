import { Injectable, computed, signal } from '@angular/core';

/** An entry the player can navigate to; `mediaFileId` is resolved lazily (playlist items lack it), so it may be absent until load. */
export interface QueueItem {
  mediaId: number;
  episodeId?: number;
  mediaFileId?: number;
  title: string;
  episodeTitle?: string;
  fanartUrl?: string | null;
  stillUrl?: string | null;
}

/** Where the active queue came from: an explicit playlist, the episodes of the series currently playing
 *  (built from its loaded media), or a watch party's own queue (`sourceId` is the party id). */
export type QueueSource = 'playlist' | 'series' | 'party';

/** The active explicit playback queue (a playlist). A launcher sets it before navigating;
 *  the player clears it when opened without a source, so a standalone play never inherits a stale queue. */
@Injectable({ providedIn: 'root' })
export class PlaybackQueueService {
  private readonly _items = signal<QueueItem[]>([]);
  private readonly _index = signal(0);
  private readonly _source = signal<QueueSource | null>(null);
  private readonly _sourceId = signal<number | null>(null);
  private readonly _autoplay = signal(false);

  /** True while a queue is driving playback. */
  readonly active = computed(() => this._items().length > 0);
  /** The ordered queue items (read-only view for the queue UI). */
  readonly items = computed(() => this._items());
  /** Cursor position of the item currently playing. */
  readonly index = computed(() => this._index());
  /** Id of the source that built the queue (e.g. the playlist id). */
  readonly sourceId = computed(() => this._sourceId());
  readonly source = computed(() => this._source());
  /** Whether the source wants back-to-back playback. */
  readonly autoplay = computed(() => this._autoplay());

  /** Begin a queue. `startIndex` is the item being launched; -1 puts the cursor before the first item. */
  start(
    items: QueueItem[],
    startIndex: number,
    opts: { source: QueueSource; sourceId: number; autoplay: boolean },
  ): void {
    this._items.set(items);
    this._index.set(Math.max(-1, Math.min(startIndex, items.length - 1)));
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

  /** Jump the cursor to an explicit index (used when the user picks an item in
   *  the queue list). Out-of-range indices are ignored. */
  setIndex(index: number): void {
    if (index >= 0 && index < this._items().length) this._index.set(index);
  }

  /** Re-align the cursor to the matching media/episode on launch, in case the launcher's index and the URL diverge. */
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
