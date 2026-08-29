import { Injectable, signal } from '@angular/core';
import { MediaType } from '../enums/media-type.enum';
import { DownloadProgressState, ProgressPhase } from '../enums/download-progress-state.enum';
import { foldLeaves } from '../../shared/utils/download-format';

/** Identifies one torrent within a season. `hash:<h>` whenever the torrent has
 *  a ref — its own identity, so two releases grabbed for the *same* episode stay
 *  two leaves instead of overwriting each other. The episode number (or `'PACK'`)
 *  keys the placeholder a grab puts up before any torrent exists; the first real
 *  tick for that scope supersedes it. */
export type LeafKey = number | 'PACK' | `hash:${string}`;

/** One in-flight torrent contributing to a media's download progress. */
export interface DownloadLeaf {
  percent: number; // 0–100
  state: ProgressPhase;
  /** The episode this torrent is for, when it names one. Held on the leaf
   *  rather than in its key, which now identifies the torrent itself. */
  episodeNumber?: number;
  /** When this leaf was last reported, for the staleness sweep. */
  updatedAt?: number;
  /** This torrent's own speed and ETA. Held per leaf because concurrent
   *  episodes each have their own, and a media-level pair could only ever
   *  report whichever of them ticked last. */
  dlspeed?: number;
  eta?: number;
}

export interface SeasonProgress {
  leaves: Map<LeafKey, DownloadLeaf>;
}

/** Live download progress for one media, keyed by `mediaId`. For a series the
 *  `seasons` sub-map holds per-(season, leaf) progress (a leaf is a season pack
 *  or an individual episode torrent); `state`/`percent` are the folded
 *  media-level rollup. A movie has no `seasons` — its single torrent's folded
 *  state and percent sit directly on the entry. */
export interface MediaDownloadProgress {
  mediaId: number;
  mediaType: MediaType;
  percent: number | null; // active-weighted mean; null when nothing is active
  state: ProgressPhase; // dominant state across all leaves
  dlspeed: number;
  eta: number;
  seasons?: Map<number, SeasonProgress>;
  /** When this entry was last reported, for the staleness sweep. Only a movie
   *  needs it here — a series is swept leaf by leaf. */
  updatedAt?: number;
}

/** Payload of a `download.progress` SSE event. */
export interface DownloadProgressEvent {
  mediaId: number;
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  hash?: string;
  progress: number; // 0–1
  dlspeed: number;
  eta: number;
  state: DownloadProgressState;
}

/** How long a leaf may go unreported before the sweep drops it. The publisher
 *  ticks about once a minute; three missed ticks is gone, not slow. Same
 *  horizon the backend's replay cache uses, for the same reason. */
const STALE_AFTER_MS = 3 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

function leafKey(episodeNumber?: number, hash?: string): LeafKey {
  if (hash) return `hash:${hash}`;
  return episodeNumber ?? 'PACK';
}

/** Fold every season leaf into the media-level state, percent, speed and ETA.
 *  Callers only reach here with at least one leaf, so `f.state` is never the
 *  empty sentinel. Speed sums across concurrent torrents and the ETA is the
 *  longest of them — the media is done when its slowest leaf is. */
function rollupSeasons(seasons: Map<number, SeasonProgress>): {
  state: ProgressPhase;
  percent: number | null;
  dlspeed: number;
  eta: number;
} {
  const leaves: DownloadLeaf[] = [];
  for (const sp of seasons.values()) {
    for (const l of sp.leaves.values()) leaves.push(l);
  }
  const f = foldLeaves(leaves);
  return {
    state: f.state || 'active',
    percent: f.percent,
    dlspeed: leaves.reduce((a, l) => a + (l.dlspeed ?? 0), 0),
    eta: leaves.reduce((a, l) => Math.max(a, l.eta ?? 0), 0),
  };
}

/**
 * App-wide store of in-flight download progress, fed by `download.progress`
 * SSE events (via {@link SseService}). One shared signal — the requests
 * views and media-detail read it by `mediaId`. The status itself
 * (label/colour/aggregation) is derived on read via the pure helpers in
 * `download-format`, so this store stays a plain data holder.
 */
@Injectable({ providedIn: 'root' })
export class DownloadProgressService {
  readonly progress = signal<Map<number, MediaDownloadProgress>>(new Map());

  private sweepHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Drop leaves nothing has reported in a while. The store is fed by events
   * alone, so a torrent that stops being reported — deleted from the download
   * client, or an acquisition plugin too old to announce its retirement — would
   * otherwise sit here at its last percent for the life of the app.
   *
   * Mirrors the backend's own replay cache, down to the horizon: the publisher
   * ticks about once a minute, so three missed ticks is a leaf that is gone
   * rather than one that was slow.
   */
  private sweepStale(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    const prev = this.progress();
    let changed = false;
    const next = new Map(prev);

    for (const [mediaId, entry] of prev) {
      if (!entry.seasons) {
        // A movie's single torrent: the entry itself is the leaf.
        if ((entry.updatedAt ?? 0) < cutoff) {
          next.delete(mediaId);
          changed = true;
        }
        continue;
      }
      const seasons = new Map(entry.seasons);
      let touched = false;
      for (const [seasonNumber, sp] of entry.seasons) {
        const leaves = new Map([...sp.leaves].filter(([, l]) => (l.updatedAt ?? 0) >= cutoff));
        if (leaves.size === sp.leaves.size) continue;
        touched = true;
        if (leaves.size === 0) seasons.delete(seasonNumber);
        else seasons.set(seasonNumber, { leaves });
      }
      if (!touched) continue;
      changed = true;
      if (seasons.size === 0) next.delete(mediaId);
      else next.set(mediaId, { ...entry, seasons, ...rollupSeasons(seasons) });
    }

    if (changed) this.progress.set(next);
    if (!next.size) this.stopSweep();
  }

  /** Runs only while something is in flight — an idle app keeps no timer. */
  private startSweep(): void {
    if (this.sweepHandle != null || typeof setInterval === 'undefined') return;
    this.sweepHandle = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  private stopSweep(): void {
    if (this.sweepHandle == null) return;
    clearInterval(this.sweepHandle);
    this.sweepHandle = null;
  }

  /** Drop everything, for the SSE connect snapshot. Progress is only ever
   *  retired by an event, so a download that ended while the stream was down
   *  would otherwise sit here at its last percent for the life of the app. */
  reset(): void {
    if (this.progress().size) this.progress.set(new Map());
    this.stopSweep();
  }

  /** Apply a `download.progress` SSE event. Updates a single leaf; deletes it
   *  (and any now-empty season/media) once it reaches 100%. */
  applyProgress(e: DownloadProgressEvent): void {
    this.applyPhase(e);
  }

  /** Same, for a phase the wire can't carry. {@link DownloadProgressEvent}
   *  stays the SSE shape so nothing suggests the backend sends `searching`. */
  private applyPhase(e: Omit<DownloadProgressEvent, 'state'> & { state: ProgressPhase }): void {
    const percent = Math.round(e.progress * 100);
    this.startSweep();
    this.progress.update((prev) => {
      const next = new Map(prev);

      if (e.mediaType === 'series' && e.seasonNumber != null) {
        const cur = next.get(e.mediaId);
        const seasons = new Map(cur?.seasons ?? []);
        const leaves = new Map(seasons.get(e.seasonNumber)?.leaves ?? []);
        const key = leafKey(e.episodeNumber, e.hash);

        // A torrent with a ref stands in for the placeholder its grab put up
        // for the same scope, which has no identity to be matched on — on a
        // retirement as much as on a live tick.
        if (e.hash) leaves.delete(e.episodeNumber ?? 'PACK');
        if (e.progress >= 1) leaves.delete(key);
        else {
          leaves.set(key, {
            percent,
            state: e.state,
            episodeNumber: e.episodeNumber,
            dlspeed: e.dlspeed,
            eta: e.eta,
            updatedAt: Date.now(),
          });
        }

        if (leaves.size === 0) seasons.delete(e.seasonNumber);
        else seasons.set(e.seasonNumber, { leaves });

        if (seasons.size === 0) {
          next.delete(e.mediaId);
          return next;
        }
        next.set(e.mediaId, {
          mediaId: e.mediaId,
          mediaType: 'series',
          seasons,
          ...rollupSeasons(seasons),
        });
        return next;
      }

      // A series tick with no season number cannot be placed. The plugin sends
      // these for a history row that never got a season/episode id, so it is a
      // steady state, not a blip. Merging one onto whichever leaf happens to be
      // alone would attribute another torrent's percent to it, and taking the
      // movie branch below would flatten the entry and lose the season map with
      // it. Drop it: the next attributed tick carries the same truth.
      if (e.mediaType === 'series') return next;

      // Movie (single torrent — no season dimension).
      if (e.progress >= 1) {
        next.delete(e.mediaId);
        return next;
      }
      const f = foldLeaves([{ percent, state: e.state }]);
      next.set(e.mediaId, {
        mediaId: e.mediaId,
        mediaType: e.mediaType,
        percent: f.percent,
        state: f.state || 'active',
        dlspeed: e.dlspeed,
        eta: e.eta,
        updatedAt: Date.now(),
      });
      return next;
    });
  }

  /**
   * Mark a grab as under way for a scope, before any torrent exists: the header
   * says "searching" from the click instead of from the download client's first
   * tick, seconds later. Returns the release to call when the request settles —
   * either way, since a failed search must not leave the badge up.
   *
   * Modelled as an ordinary leaf so scoping, folding and rendering need no
   * special case: an episode grab is keyed to that episode and stays off its
   * siblings' pages, exactly like the torrent that replaces it.
   */
  markGrabbing(e: {
    mediaId: number;
    mediaType: MediaType;
    seasonNumber?: number;
    episodeNumber?: number;
  }): () => void {
    const key = leafKey(e.episodeNumber);
    // A torrent already reporting for this scope says strictly more than
    // "searching" — leave it, and make the release a no-op.
    if (this.leafState(e) !== undefined) return () => undefined;

    this.applyPhase({ ...e, progress: 0, dlspeed: 0, eta: 0, state: 'searching' });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Real progress landed while the request was in flight: it owns the leaf.
      if (this.leafState(e) !== 'searching') return;
      this.progress.update((prev) => {
        const cur = prev.get(e.mediaId);
        if (!cur) return prev;
        const next = new Map(prev);
        if (!cur.seasons || e.seasonNumber == null) {
          next.delete(e.mediaId);
          return next;
        }
        const seasons = new Map(cur.seasons);
        const leaves = new Map(seasons.get(e.seasonNumber)?.leaves ?? []);
        leaves.delete(key);
        if (leaves.size === 0) seasons.delete(e.seasonNumber);
        else seasons.set(e.seasonNumber, { leaves });
        if (seasons.size === 0) {
          next.delete(e.mediaId);
          return next;
        }
        const rolled = rollupSeasons(seasons);
        next.set(e.mediaId, { ...cur, seasons, ...rolled });
        return next;
      });
    };
  }

  /** Phase of the leaf a grab scope maps to, or undefined when there is none. */
  private leafState(e: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
  }): ProgressPhase | undefined {
    const cur = this.progress().get(e.mediaId);
    if (!cur) return undefined;
    if (!cur.seasons || e.seasonNumber == null) return cur.state;
    // Matched on the leaf's own episode: the key identifies the torrent, so a
    // live download is keyed by its hash and reconstructing a key from the
    // episode number could only ever find the placeholder.
    for (const leaf of cur.seasons.get(e.seasonNumber)?.leaves.values() ?? []) {
      if (leaf.episodeNumber === e.episodeNumber) return leaf.state;
    }
    return undefined;
  }

  /** Retire progress for a finished import. With an `episodeNumber` on a series
   *  drop only that episode's leaf (sibling episodes keep advancing); with only
   *  a `seasonNumber` drop the whole season (pack / multi-episode import);
   *  otherwise drop the whole media entry. */
  clearMedia(
    mediaId: number,
    seasonNumber?: number,
    episodeNumber?: number,
  ): void {
    this.progress.update((prev) => {
      const cur = prev.get(mediaId);
      if (!cur) return prev;
      const next = new Map(prev);

      if (seasonNumber != null && cur.seasons) {
        const seasons = new Map(cur.seasons);
        const sp = seasons.get(seasonNumber);
        if (sp) {
          if (episodeNumber != null) {
            // By the leaf's own episode, for the same reason as `leafState`.
            // Narrower than the scope filter used for rendering: a leaf naming
            // no episode is a pack, which one episode's import doesn't finish.
            const leaves = new Map(
              [...sp.leaves].filter(([, l]) => l.episodeNumber !== episodeNumber),
            );
            if (leaves.size === 0) seasons.delete(seasonNumber);
            else seasons.set(seasonNumber, { leaves });
          } else {
            seasons.delete(seasonNumber);
          }
        }
        if (seasons.size === 0) {
          next.delete(mediaId);
        } else {
          next.set(mediaId, { ...cur, seasons, ...rollupSeasons(seasons) });
        }
      } else {
        next.delete(mediaId);
      }
      return next;
    });
  }
}
