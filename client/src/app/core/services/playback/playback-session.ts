import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { CastPlaybackTarget } from '../cast-playback-target';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { PartyService } from '../party/party.service';
import type { PlaybackOutput } from './playback-output';

export type PlaybackCommand =
  | { type: 'toggle' }
  | { type: 'seek'; at: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'item'; index: number };

/** Takes a command for the active party; false when it did not. */
export type PartyRouter = (c: PlaybackCommand) => boolean;

/** Owns where playback is happening: which output is active, whether its card is open, and where transport commands go. */
@Injectable({ providedIn: 'root' })
export class PlaybackSession {
  // Resolved on first use, so injecting the session (for `expanded`) pulls in neither the targets nor the party.
  private readonly injector = inject(Injector);
  private readonly party = () => this.injector.get(PartyService);

  private readonly local = signal<PlaybackOutput | null>(null);
  private partyRouter: PartyRouter | null = null;

  /** Whether `app-cast-overlay` shows its card. */
  readonly expanded = signal(false);
  readonly partyActive = computed(() => this.party().active());

  /** The remote target while remoting, the cast receiver while connected, else the registered local output. */
  readonly output = computed<PlaybackOutput | null>(() => {
    const remote = this.injector.get(RemotePlaybackTarget);
    if (remote.isConnected()) return remote;
    const cast = this.injector.get(CastPlaybackTarget);
    return cast.isConnected() ? cast : this.local();
  });

  /** The player registers its local output on init; the returned disposer only detaches that output. */
  attachLocal(o: PlaybackOutput): () => void {
    this.local.set(o);
    return () => this.local.update((cur) => (cur === o ? null : cur));
  }

  /** The party sync registers how it takes commands; the disposer only clears its own registration. */
  setPartyRouter(router: PartyRouter): () => void {
    this.partyRouter = router;
    return () => {
      if (this.partyRouter === router) this.partyRouter = null;
    };
  }

  /** True when a party or a non-local output took the command; false leaves the local player to act on it. */
  command(c: PlaybackCommand): boolean {
    if (this.partyActive() && this.partyRouter?.(c)) return true;
    const o = this.output();
    if (!o || o === this.local()) return false;
    switch (c.type) {
      case 'toggle':
        o.togglePlayPause();
        return true;
      case 'seek':
        o.seek(c.at);
        return true;
      case 'next':
        o.playNext();
        return true;
      default:
        return false;
    }
  }
}
