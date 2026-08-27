import { Injectable, signal } from '@angular/core';
import type { TrackingScope } from '../../shared/components/tracking-status-modal/tracking-status-modal';

/**
 * App-wide broker for the tracking-status dialog, mirroring
 * {@link RecommendService}: one modal mounted in the layout, opened from
 * anywhere — the media-detail menu, a card's menu — without the caller owning
 * the dialog. `n` is monotonic so reopening the same target still fires.
 */
@Injectable({ providedIn: 'root' })
export class TrackingModalService {
  private counter = 0;
  readonly request = signal<{ mediaId: number; scope: TrackingScope; n: number } | null>(null);

  open(mediaId: number, scope: TrackingScope): void {
    this.request.set({ mediaId, scope, n: ++this.counter });
  }

  /** Consumed by the host once it has handed the target to the modal, so a
   *  re-created layout doesn't reopen it. */
  clear(): void {
    this.request.set(null);
  }
}
