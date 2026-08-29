import { Injectable, signal } from '@angular/core';
import { MediaType } from '../enums/media-type.enum';
import { DownloadProgressState, ProgressPhase } from '../enums/download-progress-state.enum';
import { foldLeaves } from '../../shared/utils/download-format';

/** Identifies one torrent within a season: the episode number, an explicit
 *  season `'PACK'`, or `hash:<h>` when an episode torrent couldn't be resolved
 *  (so loose episodes never collide under a shared bucket). */
export type LeafKey = number | 'PACK' | `hash:${string}`;

/** One in-flight torrent contributing to a media's download progress. */
export interface DownloadLeaf {
  percent: number; // 0–100
  state: ProgressPhase;
  weight?: number; // torrent size in bytes, for a size-weighted percent (see foldLeaves)
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

function leafKey(episodeNumber?: number, hash?: string): LeafKey {
  if (episodeNumber != null) return episodeNumber;
  if (hash) return `hash:${hash}`;
  return 'PACK';
}

/** The one leaf a media holds, when it holds exactly one — the only case where
 *  an unattributed series tick can be placed without guessing. */
function soleLeafPath(
  seasons: Map<number, SeasonProgress>,
): { seasonNumber: number; key: LeafKey } | null {
  if (seasons.size !== 1) return null;
  const [seasonNumber, sp] = [...seasons.entries()][0];
  if (sp.leaves.size !== 1) return null;
  return { seasonNumber, key: [...sp.leaves.keys()][0] };
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

  /** Drop everything, for the SSE connect snapshot. Progress is only ever
   *  retired by an event, so a download that ended while the stream was down
   *  would otherwise sit here at its last percent for the life of the app. */
  reset(): void {
    if (this.progress().size) this.progress.set(new Map());
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
    this.progress.update((prev) => {
      const next = new Map(prev);

      if (e.mediaType === 'series' && e.seasonNumber != null) {
        const cur = next.get(e.mediaId);
        const seasons = new Map(cur?.seasons ?? []);
        const leaves = new Map(seasons.get(e.seasonNumber)?.leaves ?? []);
        const key = leafKey(e.episodeNumber, e.hash);

        if (e.progress >= 1) leaves.delete(key);
        else leaves.set(key, { percent, state: e.state, dlspeed: e.dlspeed, eta: e.eta });

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

      // A series tick with no season can't be attributed. Older plugin builds
      // sent these; taking the movie branch below would replace the entry and
      // destroy the season map with it — the detail modal loses the episode it
      // was naming, and the badge goes back to every episode page of the show.
      // Update the one leaf they can only belong to instead, and otherwise keep
      // the structure and let the next attributed tick correct it.
      const known = next.get(e.mediaId);
      if (e.mediaType === 'series' && known?.seasons) {
        const sole = soleLeafPath(known.seasons);
        if (!sole) return next;
        const leaves = new Map(known.seasons.get(sole.seasonNumber)!.leaves);
        if (e.progress >= 1) leaves.delete(sole.key);
        else leaves.set(sole.key, { percent, state: e.state, dlspeed: e.dlspeed, eta: e.eta });
        const seasons = new Map(known.seasons);
        if (leaves.size === 0) seasons.delete(sole.seasonNumber);
        else seasons.set(sole.seasonNumber, { leaves });
        if (seasons.size === 0) {
          next.delete(e.mediaId);
          return next;
        }
        next.set(e.mediaId, { ...known, seasons, ...rollupSeasons(seasons) });
        return next;
      }

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
    return cur.seasons.get(e.seasonNumber)?.leaves.get(leafKey(e.episodeNumber))
      ?.state;
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
            const leaves = new Map(sp.leaves);
            leaves.delete(episodeNumber);
            if (leaves.size === 0) seasons.delete(seasonNumber);
            else seasons.set(seasonNumber, { leaves });
          } else {
            seasons.delete(seasonNumber);
          }
        }
        if (seasons.size === 0) {
          next.delete(mediaId);
        } else {
          const rolled = rollupSeasons(seasons);
          next.set(mediaId, {
            ...cur,
            seasons,
            state: rolled.state,
            percent: rolled.percent,
          });
        }
      } else {
        next.delete(mediaId);
      }
      return next;
    });
  }
}
