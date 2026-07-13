import { Injectable, signal } from '@angular/core';

/** Identifies the content to recommend: a movie (mediaId), a season
 *  (+seasonId) or an episode (+episodeId). */
export interface RecommendTarget {
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
}

/**
 * App-wide broker for the "recommend to a member" dialog. A single modal is
 * mounted globally (in the layout) and opened on demand from anywhere — the
 * media-detail header, season menu — by calling {@link open}. The `request`
 * signal carries a monotonic `n` so re-requesting the same target
 * (open → close → open) still fires the bridge effect.
 */
@Injectable({ providedIn: 'root' })
export class RecommendService {
  private counter = 0;
  readonly request = signal<{ target: RecommendTarget; n: number } | null>(
    null,
  );

  open(target: RecommendTarget): void {
    this.request.set({ target, n: ++this.counter });
  }
}
