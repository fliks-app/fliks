import { Injectable, signal } from '@angular/core';

/** Whether the full player is open on this device, and whose session it shows; both outputs read it. */
@Injectable({ providedIn: 'root' })
export class FullPlayerState {
  readonly open = signal(false);
  /** The open player shows another device's session, not this one's. */
  readonly remote = signal(false);

  show(remote: boolean): void {
    this.remote.set(remote);
    this.open.set(true);
  }

  hide(): void {
    this.open.set(false);
  }

  /** The session changed device, in either direction: an open player follows it instead of closing. */
  handTo(remote: boolean): void {
    if (this.open()) this.remote.set(remote);
  }
}
