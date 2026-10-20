import { Injectable, signal } from '@angular/core';

/** Identifies the content to recommend: a movie (mediaId), a season
 *  (+seasonId) or an episode (+episodeId). */
export interface RecommendTarget {
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
}

/** App-wide broker for the "recommend to a member" dialog, opened from anywhere via {@link open}.
 * `request` carries a monotonic `n` so re-requesting the same target still fires the bridge effect. */
@Injectable({ providedIn: 'root' })
export class RecommendService {
  private counter = 0;
  readonly request = signal<{ target: RecommendTarget; n: number } | null>(
    null,
  );

  open(target: RecommendTarget): void {
    this.request.set({ target, n: ++this.counter });
  }

  /** Consumes the pending request once the layout bridge handed it off, so it doesn't reopen the modal when the layout is re-created (e.g. after the player). */
  clear(): void {
    this.request.set(null);
  }
}
