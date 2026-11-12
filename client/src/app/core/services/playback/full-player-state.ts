import { Injectable, signal } from '@angular/core';
import type { MediaFamily } from '../../media-kinds';

/** Which family's full player is open on this device, and whose session it shows; both outputs read it. */
@Injectable({ providedIn: 'root' })
export class FullPlayerState {
  readonly open = signal<MediaFamily | null>(null);
  /** The open player shows another device's session, not this one's. */
  readonly remote = signal(false);

  show(family: MediaFamily, remote: boolean): void {
    this.remote.set(remote);
    this.open.set(family);
  }

  hide(): void {
    this.open.set(null);
  }

  /** The session changed device, in either direction: an open player follows it instead of closing. */
  handTo(family: MediaFamily, remote: boolean): void {
    if (this.open() === family) this.remote.set(remote);
  }
}
