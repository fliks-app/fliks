import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { StreamingApiService } from '../api/streaming-api.service';
import { CastPlaybackTarget } from '../cast-playback-target';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { launchPickFor, type LaunchTracks } from '../track-manager.service';
import { launchTracksToWire, RemoteService } from '../remote.service';
import { ToastService } from '../toast.service';
import type { LocalOutput, PlaybackOutput } from './playback-output';

const CONNECT_WAIT_MS = 30_000;

/** What `play` opens: a file, with what the cast card and the player's backdrop show before anything loads. */
export interface PlayItem {
  fileId: number;
  mediaId: number;
  episodeId?: number;
  title: string;
  episodeTitle?: string;
  fanartUrl?: string | null;
  stillUrl?: string | null;
  streamInfo?: any;
  /** Where the caller knows playback stopped; only a remote target uses it. */
  positionSeconds?: number;
  /** Picks made on the detail header; the target honours them once, whichever it is. */
  tracks?: LaunchTracks;
}

export interface PlayOptions {
  fromStart?: boolean;
  /** Extra player query params (e.g. `playlistId`). */
  query?: Record<string, number>;
  /** Open the cast card once the item is sent. */
  expand?: boolean;
}

export type OutputKind = 'local' | 'cast' | 'remote';

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
  private readonly castSvc = () => this.injector.get(CastService);
  private readonly castPlayer = () => this.injector.get(CastPlayerService);
  private readonly remoteSvc = () => this.injector.get(RemoteService);

  private readonly local = signal<LocalOutput | null>(null);
  private moving: Promise<boolean> | null = null;
  private wasCasting = false;
  private partyRouter: PartyRouter | null = null;

  /** Whether `app-cast-overlay` shows its card. */
  readonly expanded = signal(false);
  readonly partyActive = computed(() => this.party().active());

  /** The remote target while remoting, the cast receiver while connected, else the registered local output. */
  readonly output = computed<PlaybackOutput | null>(() => {
    const kind = this.kind();
    if (kind === 'remote') return this.injector.get(RemotePlaybackTarget);
    return kind === 'cast' ? this.injector.get(CastPlaybackTarget) : this.local();
  });

  readonly kind = computed<OutputKind>(() =>
    this.injector.get(RemotePlaybackTarget).isConnected()
      ? 'remote'
      : this.injector.get(CastPlaybackTarget).isConnected()
        ? 'cast'
        : 'local',
  );
  readonly isLocal = computed(() => this.kind() === 'local');

  constructor() {
    // The one place a connect that nobody asked for (Android resume, the top-bar chip) lands.
    effect(() => {
      const casting = this.castSvc().isConnected();
      untracked(() => {
        if (casting === this.wasCasting) return;
        this.wasCasting = casting;
        if (casting) this.onCastConnected();
        else this.onCastDisconnected();
      });
    });
  }

  /** The player registers its local output on init; the returned disposer only detaches that output. */
  attachLocal(o: LocalOutput): () => void {
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

  /** The only handoff between outputs. False when refused (TV, nothing to hand over) or failed. */
  moveTo(kind: OutputKind, deviceId?: string): Promise<boolean> {
    if (this.injector.get(DeviceService).isTv()) return Promise.resolve(false);
    if (this.moving) return this.moving;
    const run =
      kind === 'local' ? this.toLocal() : kind === 'cast' ? this.toCast(deviceId) : this.toRemote(deviceId);
    const settled = run
      .catch((err) => {
        console.error('[playback-session] moveTo failed', kind, err);
        return false;
      })
      .finally(() => (this.moving = null));
    this.moving = settled;
    return settled;
  }

  /** Opens an item on the active output: loaded there without a local engine, else the player route. */
  async play(item: PlayItem, opts: PlayOptions = {}): Promise<OutputKind> {
    const kind = this.kind();
    const startAt = opts.fromStart ? 0 : undefined;
    if (kind === 'remote') {
      const remote = this.remoteSvc();
      this.expanded.set(opts.expand ?? true);
      void remote.send(remote.selectedTargetId()!, {
        action: 'load',
        mediaId: item.mediaId,
        mediaFileId: item.fileId,
        episodeId: item.episodeId,
        // The launcher's position, not the target's: a remote launch counts for whoever started it.
        positionSeconds: startAt ?? item.positionSeconds,
        ...launchTracksToWire(launchPickFor(item.tracks, item.fileId)),
      });
    } else if (kind === 'cast') {
      await this.castPlayer().quickStart({
        mediaFileId: item.fileId,
        mediaId: item.mediaId,
        episodeId: item.episodeId,
        title: item.title,
        episodeTitle: item.episodeTitle,
        fanartUrl: item.fanartUrl ?? null,
        streamInfo: item.streamInfo,
        startTime: startAt,
        tracks: item.tracks,
        expand: opts.expand ?? true,
      });
    } else {
      const query: Record<string, number> = { mediaId: item.mediaId, ...opts.query };
      if (item.episodeId) query['episodeId'] = item.episodeId;
      if (opts.fromStart) query['t'] = 0;
      // Router state lets the player paint the backdrop on its first tick; `stillUrl` wins over `fanartUrl`.
      void this.injector.get(Router).navigate(['/watch', item.fileId], {
        queryParams: query,
        state: { fanartUrl: item.fanartUrl ?? null, stillUrl: item.stillUrl ?? null, tracks: item.tracks ?? null },
      });
    }
    return kind;
  }

  private async toCast(deviceId?: string): Promise<boolean> {
    const cast = this.castSvc();
    if (!cast.isConnected() && !(await this.connectCast(deviceId))) return false;
    const local = this.local();
    const handoff = await local?.release();
    if (!local || !handoff) return true;
    const cp = this.castPlayer();
    if (handoff.resolveSubtitle) {
      const sub = await cp.resolveStartSubtitle(
        handoff.cast.subtitles, handoff.cast.mediaFileId, handoff.cast.mediaId, handoff.audioLanguage,
      );
      handoff.cast.activeSubtitleId = sub?.id ?? null;
    }
    cp.startCast(handoff.cast);
    // The cast ladder comes from the cast profile's own playback-info, not the browser one.
    await cp.reloadCastStream(handoff.position, true, handoff.cast.activeQualityId);
    const sid = handoff.localSessionId;
    if (sid && sid !== cp.liveSessionId()) void this.injector.get(StreamingApiService).stopSession(sid).catch(() => {});
    this.leaveLocal(local);
    return true;
  }

  private async toRemote(targetId?: string): Promise<boolean> {
    const local = this.local();
    if (!targetId || !local) return false;
    const handoff = await local.release();
    if (!handoff) return false;
    const remote = this.remoteSvc();
    remote.selectTarget(targetId);
    void remote.send(targetId, {
      action: 'load',
      mediaId: handoff.cast.mediaId,
      mediaFileId: handoff.cast.mediaFileId,
      episodeId: handoff.cast.episodeId,
      positionSeconds: Math.floor(handoff.position),
    });
    this.leaveLocal(local);
    return true;
  }

  private async toLocal(): Promise<boolean> {
    const local = this.local();
    const from = this.output();
    if (!local || !from || from === local) return false;
    const position = from.position();
    if (this.kind() === 'remote') this.remoteSvc().selectTarget(null);
    else {
      this.castSvc().disconnect();
      this.castPlayer().clear();
    }
    await local.resume(position);
    return true;
  }

  /** A party stays on the player route, which keeps its sync alive; otherwise the player steps aside. */
  private leaveLocal(local: LocalOutput): void {
    this.expanded.set(true);
    if (!this.party().active()) local.disconnect();
  }

  private async connectCast(deviceId?: string): Promise<boolean> {
    const cast = this.castSvc();
    if (deviceId) {
      try {
        await cast.selectCastDevice(deviceId);
      } catch (err) {
        console.warn('[playback-session] selectCastDevice failed', deviceId, err);
        this.injector.get(ToastService).error(this.injector.get(TranslateService).instant('remote.error_cast_select_failed'));
        return false;
      }
    } else {
      cast.requestSession();
    }
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        ref.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), CONNECT_WAIT_MS);
      const ref = effect(
        () => {
          if (cast.isConnected()) finish(true);
          else if (!cast.connecting()) finish(false);
        },
        { injector: this.injector },
      );
    });
  }

  private onCastConnected(): void {
    const local = this.local();
    if (!local || this.moving || local.item().mediaId === 0) return;
    // A receiver that already plays keeps its media: only this device falls silent.
    if (this.castPlayer().hasMedia()) local.stepAside();
    else void this.moveTo('cast');
  }

  private onCastDisconnected(): void {
    const local = this.local();
    if (!local || this.moving) return;
    void local.resume(this.castSvc().currentTime());
  }
}
