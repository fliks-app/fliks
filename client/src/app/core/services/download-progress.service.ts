import { Injectable, inject, signal } from '@angular/core';
import { MediaType } from '../enums/media-type.enum';
import { DownloadClientsApiService } from './api/download-clients-api.service';
import { foldLeaves } from '../../shared/utils/download-format';

/** Identifies one torrent within a season: the episode number, an explicit
 *  season `'PACK'`, or `hash:<h>` when an episode torrent couldn't be resolved
 *  (so loose episodes never collide under a shared bucket). */
export type LeafKey = number | 'PACK' | `hash:${string}`;

/** One in-flight torrent contributing to a media's download progress. */
export interface DownloadLeaf {
  percent: number; // 0–100
  state: string; // raw qBittorrent state
  weight?: number; // torrent size in bytes; set from the queue seed, absent on SSE
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
  state: string; // dominant raw state across all leaves
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
  state: string;
}

function leafKey(episodeNumber?: number, hash?: string): LeafKey {
  if (episodeNumber != null) return episodeNumber;
  if (hash) return `hash:${hash}`;
  return 'PACK';
}

/** Fold every season leaf into the media-level state + percent. */
function rollupSeasons(seasons: Map<number, SeasonProgress>): {
  state: string;
  percent: number | null;
} {
  const leaves: DownloadLeaf[] = [];
  for (const sp of seasons.values()) {
    for (const l of sp.leaves.values()) leaves.push(l);
  }
  const f = foldLeaves(leaves);
  return { state: f.state, percent: f.percent };
}

/**
 * App-wide store of in-flight download progress, fed primarily by
 * `download.progress` SSE events (via {@link SseService}) and seeded once from
 * the download queue when a surface mounts mid-download. One shared signal —
 * the requests views and media-detail read it by `mediaId`. The status itself
 * (label/colour/aggregation) is derived on read via the pure helpers in
 * `download-format`, so this store stays a plain data holder.
 */
@Injectable({ providedIn: 'root' })
export class DownloadProgressService {
  private readonly api = inject(DownloadClientsApiService);

  readonly progress = signal<Map<number, MediaDownloadProgress>>(new Map());

  /** Bumped on every live mutation (SSE apply/clear) so an in-flight seed()
   *  can detect a fresher update landed during its fetch and not clobber it. */
  private mutationGen = 0;

  /** Apply a `download.progress` SSE event. Updates a single leaf; deletes it
   *  (and any now-empty season/media) once it reaches 100%. */
  applyProgress(e: DownloadProgressEvent): void {
    const percent = Math.round(e.progress * 100);
    this.mutationGen++;
    this.progress.update((prev) => {
      const next = new Map(prev);

      if (e.mediaType === 'series' && e.seasonNumber != null) {
        const cur = next.get(e.mediaId);
        const seasons = new Map(cur?.seasons ?? []);
        const leaves = new Map(seasons.get(e.seasonNumber)?.leaves ?? []);
        const key = leafKey(e.episodeNumber, e.hash);

        if (e.progress >= 1) leaves.delete(key);
        else leaves.set(key, { percent, state: e.state });

        if (leaves.size === 0) seasons.delete(e.seasonNumber);
        else seasons.set(e.seasonNumber, { leaves });

        if (seasons.size === 0) {
          next.delete(e.mediaId);
          return next;
        }
        const rolled = rollupSeasons(seasons);
        next.set(e.mediaId, {
          mediaId: e.mediaId,
          mediaType: 'series',
          percent: rolled.percent,
          state: rolled.state,
          dlspeed: e.dlspeed,
          eta: e.eta,
          seasons,
        });
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
        state: f.state,
        dlspeed: e.dlspeed,
        eta: e.eta,
      });
      return next;
    });
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
    this.mutationGen++;
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

  /** Rebuild the map from the current download queue — covers a page opened
   *  mid-download before the next SSE tick. Rebuilds (never merges) so a
   *  finished torrent that left the queue drops out. Queue items carry `size`,
   *  so seeded leaves get a `weight` for the size-weighted percent. Bails if a
   *  live SSE mutation landed during the fetch (trusts the fresher state). */
  async seed(): Promise<void> {
    const gen = this.mutationGen;
    try {
      const res = await this.api.getQueue({ pageSize: 100 });
      if (gen !== this.mutationGen) return;
      const map = new Map<number, MediaDownloadProgress>();
      for (const it of res.items) {
        if (it.mediaId == null || it.progress >= 1) continue;
        const percent = Math.round(it.progress * 100);
        const leaf: DownloadLeaf = {
          percent,
          state: it.state,
          weight: it.size,
        };
        if (it.mediaType === 'series' && it.seasonNumber != null) {
          const cur = map.get(it.mediaId);
          const seasons = new Map(cur?.seasons ?? []);
          const leaves = new Map(seasons.get(it.seasonNumber)?.leaves ?? []);
          leaves.set(leafKey(it.episodeNumber, it.hash), leaf);
          seasons.set(it.seasonNumber, { leaves });
          const rolled = rollupSeasons(seasons);
          map.set(it.mediaId, {
            mediaId: it.mediaId,
            mediaType: 'series',
            percent: rolled.percent,
            state: rolled.state,
            dlspeed: it.dlspeed,
            eta: it.eta,
            seasons,
          });
        } else {
          const f = foldLeaves([leaf]);
          map.set(it.mediaId, {
            mediaId: it.mediaId,
            mediaType: it.mediaType ?? 'movie',
            percent: f.percent,
            state: f.state,
            dlspeed: it.dlspeed,
            eta: it.eta,
          });
        }
      }
      this.progress.set(map);
    } catch {
      /* ignore — SSE will populate as events arrive */
    }
  }
}
