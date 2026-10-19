import { computed, effect, signal, untracked } from '@angular/core';
import type { Episode, Media } from '../../core/services/api/media.service';
import type { LikeState, LikesApiService } from '../../core/services/api/likes-api.service';

export interface LikeHost {
  media(): Media | null;
  episodeMode(): boolean;
  focusedEpisode(): Episode | null;
}

/** What the viewer liked on the open title: the title or focused episode, seasons and episodes. */
export class LikeController {
  readonly state = signal<LikeState>({ media: false, seasonIds: [], episodeIds: [] });
  /** Like state of the header's current target (movie, or the focused episode). */
  readonly focusedLiked = computed(() => {
    const st = this.state();
    if (this.host.episodeMode()) {
      const ep = this.host.focusedEpisode();
      return ep ? st.episodeIds.includes(ep.id) : false;
    }
    return st.media;
  });

  private lastLikeStateId = 0;

  /** Call from an injection context: it registers the effects that keep the state current. */
  constructor(
    private readonly host: LikeHost,
    private readonly api: LikesApiService,
  ) {
    effect(() => {
      const id = this.host.media()?.id ?? 0;
      if (id && id !== this.lastLikeStateId) {
        this.lastLikeStateId = id;
        void this.load(id);
      }
    });
    effect(() => {
      const changed = this.api.changed();
      const id = untracked(() => this.host.media())?.id;
      if (changed && changed.mediaId === id) void this.load(id);
    });
  }

  private async load(id: number): Promise<void> {
    try {
      this.state.set(await this.api.state(id, { force: true }));
    } catch {
      /* interceptor surfaces errors */
    }
  }

  seasonLiked(seasonId: number): boolean {
    return this.state().seasonIds.includes(seasonId);
  }

  /** Toggle the like on the header target (movie / focused episode). */
  async toggle(): Promise<void> {
    const m = this.host.media();
    if (!m) return;
    const ep = this.host.episodeMode() ? this.host.focusedEpisode() : null;
    const target = ep ? { mediaId: m.id, episodeId: ep.id } : { mediaId: m.id };
    const wasLiked = this.focusedLiked();
    this.state.update((st) =>
      ep
        ? {
            ...st,
            episodeIds: wasLiked
              ? st.episodeIds.filter((i) => i !== ep.id)
              : [...st.episodeIds, ep.id],
          }
        : { ...st, media: !wasLiked },
    );
    try {
      if (wasLiked) await this.api.unlike(target);
      else await this.api.like(target);
    } catch {
      void this.load(m.id);
    }
  }

  toggleSeason(seasonId: number): Promise<void> {
    return this.toggleId('seasonIds', seasonId);
  }

  toggleEpisode(episodeId: number): Promise<void> {
    return this.toggleId('episodeIds', episodeId);
  }

  private async toggleId(key: 'seasonIds' | 'episodeIds', id: number): Promise<void> {
    const m = this.host.media();
    if (!m) return;
    const wasLiked = this.state()[key].includes(id);
    this.state.update((st) => ({
      ...st,
      [key]: wasLiked ? st[key].filter((i) => i !== id) : [...st[key], id],
    }));
    const target = key === 'seasonIds' ? { mediaId: m.id, seasonId: id } : { mediaId: m.id, episodeId: id };
    try {
      if (wasLiked) await this.api.unlike(target);
      else await this.api.like(target);
    } catch {
      void this.load(m.id);
    }
  }
}
