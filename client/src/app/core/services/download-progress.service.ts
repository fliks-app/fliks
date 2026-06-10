import { Injectable, inject, signal } from '@angular/core';
import { MediaType } from '../enums/media-type.enum';
import { DownloadClientsApiService } from './api/download-clients-api.service';

/** Live download progress for one media, keyed by `mediaId`. For series the
 *  `seasons` sub-map holds per-season progress and `percent` is their mean. */
export interface MediaDownloadProgress {
  mediaId: number;
  mediaType: MediaType;
  percent: number; // 0–100
  state: string;
  dlspeed: number;
  eta: number;
  seasons?: Map<number, { percent: number; state: string }>;
}

/** Payload of a `download.progress` SSE event (fields read off the generic
 *  SseEvent and narrowed by the caller). */
export interface DownloadProgressEvent {
  mediaId: number;
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  progress: number; // 0–1
  dlspeed: number;
  eta: number;
  state: string;
}

function seasonsRollup(seasons: Map<number, { percent: number }>): number {
  if (seasons.size === 0) return 0;
  let sum = 0;
  for (const v of seasons.values()) sum += v.percent;
  return Math.round(sum / seasons.size);
}

/**
 * App-wide store of in-flight download progress, fed primarily by
 * `download.progress` SSE events (via {@link SseService}) and seeded once from
 * the download queue when a surface mounts mid-download. One shared signal —
 * the requests views and media-detail read it by `mediaId`. No client polling.
 */
@Injectable({ providedIn: 'root' })
export class DownloadProgressService {
  private readonly api = inject(DownloadClientsApiService);

  readonly progress = signal<Map<number, MediaDownloadProgress>>(new Map());

  /** Bumped on every live mutation (SSE apply/clear) so an in-flight seed()
   *  can detect a fresher update landed during its fetch and not clobber it. */
  private mutationGen = 0;

  /** Apply a `download.progress` SSE event. Clears the entry on completion. */
  applyProgress(e: DownloadProgressEvent): void {
    const percent = Math.round(e.progress * 100);
    this.mutationGen++;
    this.progress.update((prev) => {
      const next = new Map(prev);
      const isSeriesSeason =
        e.mediaType === 'series' && e.seasonNumber != null;

      if (e.progress >= 1) {
        const cur = next.get(e.mediaId);
        if (cur?.seasons && isSeriesSeason) {
          const seasons = new Map(cur.seasons);
          seasons.delete(e.seasonNumber!);
          if (seasons.size === 0) next.delete(e.mediaId);
          else
            next.set(e.mediaId, {
              ...cur,
              seasons,
              percent: seasonsRollup(seasons),
            });
        } else {
          next.delete(e.mediaId);
        }
        return next;
      }

      if (isSeriesSeason) {
        const cur = next.get(e.mediaId);
        const seasons = new Map(cur?.seasons ?? []);
        seasons.set(e.seasonNumber!, { percent, state: e.state });
        next.set(e.mediaId, {
          mediaId: e.mediaId,
          mediaType: 'series',
          percent: seasonsRollup(seasons),
          state: e.state,
          dlspeed: e.dlspeed,
          eta: e.eta,
          seasons,
        });
      } else {
        next.set(e.mediaId, {
          mediaId: e.mediaId,
          mediaType: e.mediaType,
          percent,
          state: e.state,
          dlspeed: e.dlspeed,
          eta: e.eta,
        });
      }
      return next;
    });
  }

  /** Retire progress for a finished import. With a `seasonNumber` on a series,
   *  drop only that season (other in-flight seasons keep advancing); otherwise
   *  drop the whole media entry. */
  clearMedia(mediaId: number, seasonNumber?: number): void {
    this.mutationGen++;
    this.progress.update((prev) => {
      const cur = prev.get(mediaId);
      if (!cur) return prev;
      const next = new Map(prev);
      if (seasonNumber != null && cur.seasons) {
        const seasons = new Map(cur.seasons);
        seasons.delete(seasonNumber);
        if (seasons.size === 0) next.delete(mediaId);
        else
          next.set(mediaId, {
            ...cur,
            seasons,
            percent: seasonsRollup(seasons),
          });
      } else {
        next.delete(mediaId);
      }
      return next;
    });
  }

  /** Rebuild the map from the current download queue — covers a page opened
   *  mid-download before the next SSE tick. Rebuilds (never merges) so a
   *  finished torrent that left the queue drops out. Bails if a live SSE
   *  mutation landed during the fetch (trusts the fresher live state). */
  async seed(): Promise<void> {
    const gen = this.mutationGen;
    try {
      const res = await this.api.getQueue({ pageSize: 100 });
      if (gen !== this.mutationGen) return;
      const map = new Map<number, MediaDownloadProgress>();
      for (const it of res.items) {
        if (it.mediaId == null || it.progress >= 1) continue;
        const percent = Math.round(it.progress * 100);
        if (it.mediaType === 'series' && it.seasonNumber != null) {
          const cur = map.get(it.mediaId);
          const seasons = new Map(cur?.seasons ?? []);
          seasons.set(it.seasonNumber, { percent, state: it.state });
          map.set(it.mediaId, {
            mediaId: it.mediaId,
            mediaType: 'series',
            percent: seasonsRollup(seasons),
            state: it.state,
            dlspeed: it.dlspeed,
            eta: it.eta,
            seasons,
          });
        } else {
          map.set(it.mediaId, {
            mediaId: it.mediaId,
            mediaType: it.mediaType ?? 'movie',
            percent,
            state: it.state,
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
