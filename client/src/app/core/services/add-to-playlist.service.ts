import { Injectable, signal } from '@angular/core';

/**
 * App-wide broker for the "add this media to a playlist" dialog. A single
 * modal is mounted globally (in the layout) and opened on demand from anywhere
 * — media cards, the media-detail header — by calling {@link open}. The
 * `request` signal carries a monotonic `n` so re-requesting the same media id
 * (open → close → open) still fires the bridge effect.
 */
@Injectable({ providedIn: 'root' })
export class AddToPlaylistService {
  private counter = 0;
  readonly request = signal<{ mediaId: number; n: number } | null>(null);

  open(mediaId: number): void {
    this.request.set({ mediaId, n: ++this.counter });
  }
}
