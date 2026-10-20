import { Injectable, signal } from '@angular/core';
import { AddToPlaylistBody } from './api/playlists-api.service';

/** Broker for the app-wide "add to a playlist" modal, opened via {@link open} with `mediaId`, `episodeId` or `seasonId` scope;
 *  `request` carries a monotonic `n` so re-requesting the same target still fires the bridge effect. */
@Injectable({ providedIn: 'root' })
export class AddToPlaylistService {
  private counter = 0;
  readonly request = signal<{ target: AddToPlaylistBody; n: number } | null>(
    null,
  );

  open(target: AddToPlaylistBody): void {
    this.request.set({ target, n: ++this.counter });
  }

  /** Consume the pending request once handed to the modal, so it doesn't reopen when the layout is re-created (e.g. after the player). */
  clear(): void {
    this.request.set(null);
  }
}
