import { Injectable, signal } from '@angular/core';
import { AddToPlaylistBody } from './api/playlists-api.service';

/**
 * App-wide broker for the "add to a playlist" dialog. A single modal is mounted
 * globally (in the layout) and opened on demand from anywhere — media cards,
 * the media-detail header, episode/season rows — by calling {@link open}. The
 * `request` signal carries a monotonic `n` so re-requesting the same target
 * (open → close → open) still fires the bridge effect.
 *
 * The target selects the scope: `mediaId` (a movie, or a series → all its
 * episodes), `episodeId` (one episode) or `seasonId` (a whole season).
 */
@Injectable({ providedIn: 'root' })
export class AddToPlaylistService {
  private counter = 0;
  readonly request = signal<{ target: AddToPlaylistBody; n: number } | null>(
    null,
  );

  open(target: AddToPlaylistBody): void {
    this.request.set({ target, n: ++this.counter });
  }
}
