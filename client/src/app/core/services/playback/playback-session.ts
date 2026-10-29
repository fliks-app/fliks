import { EffectRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { StreamingApiService } from '../api/streaming-api.service';
import { CastPlaybackTarget } from '../cast-playback-target';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { NowPlayingMetadataService } from './now-playing-metadata.service';
import type { Media } from '../api/media.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { parseDeviceLabel } from '../../utils/format-device-label';
import { launchPickFor, type LaunchTracks } from '../track-manager.service';
import { launchTracksToWire, RemoteService } from '../remote.service';
import { ToastService } from '../toast.service';
import type { LocalOutput, PlaybackOutput } from './playback-output';

const CONNECT_WAIT_MS = 30_000;

/** What `play` opens: the identity of a file. Display metadata comes from `NowPlayingMetadataService`. */
export interface PlayItem {
  fileId: number;
  mediaId: number;
  episodeId?: number;
  /** The media when the caller already loaded it, so the output does not fetch it again. */
  media?: Media;
  /** Loading-screen backdrop of the local player, before its media has loaded. */
  backdropUrl?: string | null;
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
  /** Open the player route on the item once it is sent to another output (default true). */
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

/** Owns where playback is happening: which output is active and where transport commands go. */
@Injectable({ providedIn: 'root' })
export class PlaybackSession {
  // Resolved on first use, so injecting the session pulls in neither the targets nor the party.
  private readonly injector = inject(Injector);
  private readonly party = () => this.injector.get(PartyService);
  private readonly castSvc = () => this.injector.get(CastService);
  private readonly castPlayer = () => this.injector.get(CastPlayerService);
  private readonly remoteSvc = () => this.injector.get(RemoteService);
  private readonly router = () => this.injector.get(Router);

  private readonly local = signal<LocalOutput | null>(null);
  private moving: Promise<boolean> | null = null;
  private wasCasting = false;
  private wasAway = false;
  /** Set by `stopControlling`: that return to this device is deliberate and must not resume it. */
  private releasing = false;
  private watchReturns: EffectRef | null = null;
  /** Where the cast or remote output last was: once it is gone, its own position reads nothing. */
  private awayPosition = 0;
  private awayPaused = false;
  private partyRouter: PartyRouter | null = null;
  /** File the output already holds, set by whoever opens the player route on it. */
  private opened = 0;

  readonly partyActive = computed(() => this.party().drives());

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

  /** Display metadata of what the cast or remote output plays; null while local or loading. */
  readonly nowPlaying = inject(NowPlayingMetadataService).track(() => {
    if (this.kind() === 'local') return null;
    const { mediaId, episodeId } = this.output()!.item();
    return mediaId ? { mediaId, episodeId } : null;
  });

  /** Name of the device playing, null while local. */
  readonly deviceName = computed<string | null>(() => {
    const kind = this.kind();
    const translate = this.injector.get(TranslateService);
    if (kind === 'cast') {
      return this.castSvc().castDevices().find((d) => d.connected)?.name ?? 'Chromecast';
    }
    if (kind !== 'remote') return null;
    const t = this.remoteSvc().selectedTarget();
    const label = t && parseDeviceLabel(t.userAgent, t.systemName, t.deviceName);
    return label ? translate.instant(label.key, label.params) : null;
  });

  constructor() {
    // The one place a connect that nobody asked for (Android resume, the top-bar chip) lands.
    effect(() => {
      const casting = this.castSvc().isConnected();
      untracked(() => {
        if (casting === this.wasCasting) return;
        this.wasCasting = casting;
        if (casting) this.onCastConnected();
      });
    });
  }

  /** The player registers its local output once its route is set up; the disposer only detaches that output. */
  attachLocal(o: LocalOutput): () => void {
    this.watchReturns ??= this.watchReturnsToLocal();
    this.local.set(o);
    if (this.takeBackOnAttach) {
      this.takeBackOnAttach = false;
      void this.moveTo('local');
    }
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

  private takeBackOnAttach = false;

  /** Brings playback back here; with no player mounted it opens one first, and an idle output is just released. */
  takeBack(): void {
    if (this.isLocal()) return;
    if (this.local()) {
      void this.moveTo('local');
    } else if (this.playing()) {
      this.takeBackOnAttach = true;
      this.openPlayer();
    } else if (this.kind() === 'remote') {
      this.remoteSvc().selectTarget(null);
    } else {
      this.castSvc().disconnect();
    }
  }

  /** The only handoff between outputs. False when refused (TV, nothing to hand over) or failed. */
  moveTo(kind: OutputKind, deviceId?: string): Promise<boolean> {
    if (this.injector.get(DeviceService).isTv()) return Promise.resolve(false);
    if (this.moving) return this.moving;
    const from = this.kind();
    const run =
      kind === 'local'
        ? this.toLocal()
        : from !== 'local' && from !== kind
          ? this.switchAway(kind, deviceId)
          : kind === 'cast'
            ? this.toCast(deviceId)
            : this.toRemote(deviceId);
    const settled = run
      .catch((err) => {
        console.error('[playback-session] moveTo failed', kind, err);
        return false;
      })
      .finally(() => (this.moving = null));
    this.moving = settled;
    return settled;
  }

  /** Lets go of the remote device without taking the playback back: it plays on alone and the player closes. */
  stopControlling(): void {
    if (this.kind() !== 'remote') return;
    this.releasing = true;
    this.remoteSvc().selectTarget(null);
    this.local()?.disconnect();
  }

  /** Opens an item on the active output: loaded there without a local engine, else the player route. */
  async play(item: PlayItem, opts: PlayOptions = {}): Promise<OutputKind> {
    const kind = this.kind();
    const startAt = opts.fromStart ? 0 : undefined;
    if (kind === 'remote') {
      const remote = this.remoteSvc();
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
        media: item.media,
        streamInfo: item.streamInfo,
        startTime: startAt,
        tracks: item.tracks,
      });
    } else {
      const query: Record<string, number> = { mediaId: item.mediaId, ...opts.query };
      if (item.episodeId) query['episodeId'] = item.episodeId;
      if (opts.fromStart) query['t'] = 0;
      // Router state lets the player paint the backdrop on its first tick.
      void this.router().navigate(['/watch', item.fileId], {
        queryParams: query,
        state: { backdropUrl: item.backdropUrl ?? null, tracks: item.tracks ?? null },
      });
    }
    if (kind !== 'local' && (opts.expand ?? true)) this.openPlayer(item);
    return kind;
  }

  /** Opens the player route on what the active output plays, without reloading it; nothing to open while the output is idle. */
  openPlayer(item?: { fileId: number; mediaId: number; episodeId?: number }): void {
    const target = item ?? this.playing();
    if (!target?.fileId || this.router().url.startsWith('/watch')) return;
    this.opened = target.fileId;
    const query: Record<string, number> = { mediaId: target.mediaId };
    if (target.episodeId) query['episodeId'] = target.episodeId;
    const party = this.party();
    if (party.drives()) query['party'] = party.party()!.id;
    void this.router().navigate(['/watch', target.fileId], { queryParams: query });
  }

  /** The player route asks whether the output was already opened on this file; true once, so a reload loads normally. */
  claimOpened(fileId: number): boolean {
    const held = this.opened === fileId;
    this.opened = 0;
    return held;
  }

  /** What the cast receiver or remote target is playing, with the file the route needs. */
  readonly playing = computed<{ fileId: number; mediaId: number; episodeId?: number } | null>(() => {
    const kind = this.kind();
    if (kind === 'local') return null;
    const { mediaId, episodeId } = this.output()!.item();
    const fileId = kind === 'cast' ? this.castPlayer().mediaFileId() : (this.remoteSvc().targetState()?.mediaFileId ?? 0);
    return fileId && mediaId ? { fileId, mediaId, episodeId } : null;
  });

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
    const sid = handoff.localSessionId;
    if (sid) void this.injector.get(StreamingApiService).stopSession(sid).catch(() => {});
    return true;
  }

  /** Cast and remote swap without the local engine starting in between. */
  private async switchAway(kind: 'cast' | 'remote', deviceId?: string): Promise<boolean> {
    const from = this.output();
    const cur = this.playing();
    if (!from || !cur || (kind === 'remote' && !deviceId)) return false;
    const position = from.position();
    const audio = /^audio-(\d+)$/.exec(from.activeAudioTrackId() ?? '');
    const tracks: LaunchTracks = {
      fileId: cur.fileId,
      audioStreamIndex: audio ? Number(audio[1]) : undefined,
      subtitleId: from.activeSubtitleId(),
    };
    if (kind === 'cast') {
      if (!(await this.connectCast(deviceId))) return false;
      await from.pause();
      from.disconnect();
      await this.castPlayer().quickStart({
        mediaFileId: cur.fileId, mediaId: cur.mediaId, episodeId: cur.episodeId, startTime: position, tracks,
      });
      return true;
    }
    const remote = this.remoteSvc();
    from.disconnect();
    remote.selectTarget(deviceId!);
    void remote.send(deviceId!, {
      action: 'load',
      mediaId: cur.mediaId,
      mediaFileId: cur.fileId,
      episodeId: cur.episodeId,
      positionSeconds: Math.floor(position),
      ...launchTracksToWire(tracks),
    });
    return true;
  }

  private async toLocal(): Promise<boolean> {
    const local = this.local();
    const from = this.output();
    if (!local || !from || from === local) return false;
    const position = from.position();
    const paused = from.paused();
    if (this.kind() === 'remote') {
      // Only one device plays: the one left behind closes its player.
      from.stopPlayback();
      this.remoteSvc().selectTarget(null);
    } else {
      this.castSvc().disconnect();
      this.castPlayer().clear();
    }
    await local.resume(position, paused);
    return true;
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

  /** Any way back to this device that `moveTo` did not take (receiver lost, "stop controlling", the mini-bar's
   *  close) restarts the local player where the other output was. Created on first attach: it reads the targets. */
  private watchReturnsToLocal() {
    return effect(
      () => {
        const away = this.kind() !== 'local';
        const o = this.output();
        if (away && o) {
          this.awayPosition = o.position() || this.awayPosition;
          this.awayPaused = o.paused();
        }
        untracked(() => {
          if (away === this.wasAway) return;
          this.wasAway = away;
          if (!away) this.onBackToLocal();
        });
      },
      { injector: this.injector },
    );
  }

  private onBackToLocal(): void {
    const releasing = this.releasing;
    this.releasing = false;
    const local = this.local();
    if (!local || this.moving || releasing) return;
    void local.resume(this.awayPosition, this.awayPaused);
  }
}
