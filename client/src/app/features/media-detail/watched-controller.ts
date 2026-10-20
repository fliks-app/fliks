import { computed, signal } from '@angular/core';
import type { Media, Season, Episode } from '../../core/services/api/media.service';
import type { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { filesForEpisode } from './media-detail.utils';

export interface WatchedHost {
  media(): Media | null;
}

/** Which episodes of the open series are watched and how far the others got, kept in step
 *  with the toggles the page, its cards and the header make. */
export class WatchedController {
  readonly episodeIds = signal<Set<number>>(new Set());
  readonly episodeProgress = signal<Record<number, number>>({});
  readonly seasonBusy = signal<number | null>(null);

  /** True iff every downloaded episode in a non-special season is watched; drives the series root toggle. */
  readonly seriesFullyWatched = computed(() => {
    const m = this.host.media();
    if (m?.type !== 'series' || !m.seasons?.length) return false;
    const watched = this.episodeIds();
    let total = 0;
    for (const s of m.seasons) {
      if (!s.seasonNumber || s.seasonNumber <= 0) continue;
      for (const ep of s.episodes ?? []) {
        if (!ep.hasFile) continue;
        total++;
        if (!watched.has(ep.id)) return false;
      }
    }
    return total > 0;
  });

  constructor(
    private readonly host: WatchedHost,
    private readonly streamingApi: StreamingApiService,
  ) {}

  reset(): void {
    this.episodeIds.set(new Set());
    this.episodeProgress.set({});
  }

  /** True iff every downloaded episode of `season` is watched. Drives the
   *  watch/unwatch label on the season card menu and the card's watched badge. */
  seasonFullyWatched(season: Season): boolean {
    const watched = this.episodeIds();
    let total = 0;
    for (const ep of season.episodes ?? []) {
      if (!ep.hasFile) continue;
      total++;
      if (!watched.has(ep.id)) return false;
    }
    return total > 0;
  }

  /** Series root watched toggle: the header already POSTed the bulk endpoint, so mirror its rule locally. */
  async onToggleSeasonWatched(mediaId: number, season: Season, watched: boolean) {
    if (this.seasonBusy() === season.id) return;
    this.seasonBusy.set(season.id);
    try {
      await this.streamingApi.toggleSeasonWatched(mediaId, season.id, watched);
      // Mirror server-side reset locally so progress bars + watched badges
      // refresh without a reload.
      const nextWatched = new Set(this.episodeIds());
      const nextProgress = { ...this.episodeProgress() };
      for (const ep of season.episodes ?? []) {
        if (watched) {
          if (ep.hasFile) nextWatched.add(ep.id);
        } else {
          nextWatched.delete(ep.id);
        }
        delete nextProgress[ep.id];
      }
      this.episodeIds.set(nextWatched);
      this.episodeProgress.set(nextProgress);
    } catch {
      /* ignore — global error toast handles it */
    } finally {
      this.seasonBusy.set(null);
    }
  }

  /** Toggle one episode's watched state via its latest media file, updating the local set optimistically. */
  async onToggleEpisodeWatched(mediaId: number, episode: Episode, watched: boolean) {
    const files = filesForEpisode(this.host.media()?.files, episode.id);
    const fileId = files[0]?.id;
    if (!fileId) return;

    const prev = this.episodeIds();
    this.applyEpisodeLocal(episode.id, watched);

    try {
      await this.streamingApi.toggleWatched(mediaId, fileId, episode.id);
    } catch {
      this.episodeIds.set(prev);
    }
  }

  /** Mirror the header's episode toggle (API already called): refresh local watched/progress for the surrounding cards. */
  onEpisodeToggledFromHeader(payload: { episodeId: number; watched: boolean }) {
    this.applyEpisodeLocal(payload.episodeId, payload.watched);
  }

  private applyEpisodeLocal(episodeId: number, watched: boolean): void {
    const next = new Set(this.episodeIds());
    if (watched) next.add(episodeId);
    else next.delete(episodeId);
    this.episodeIds.set(next);

    const nextProgress = { ...this.episodeProgress() };
    delete nextProgress[episodeId];
    this.episodeProgress.set(nextProgress);
  }

  onSeriesToggled(payload: { watched: boolean }) {
    const m = this.host.media();
    if (!m?.seasons?.length) return;
    // Bulk toggle wipes every episode's positionSeconds server-side — mirror
    // that locally so progress bars on episode cards disappear immediately.
    this.episodeProgress.set({});
    if (!payload.watched) {
      this.episodeIds.set(new Set());
      return;
    }
    const ids = new Set<number>();
    for (const s of m.seasons) {
      if (!s.seasonNumber || s.seasonNumber <= 0) continue;
      for (const ep of s.episodes ?? []) {
        if (ep.hasFile) ids.add(ep.id);
      }
    }
    this.episodeIds.set(ids);
  }
}
