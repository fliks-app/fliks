import { EffectRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import { StreamingApiService } from '../api/streaming-api.service';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { MusicCastOutput, type MusicCastState } from '../audio-player/music-cast-output';
import { CastPlaybackTarget } from '../cast-playback-target';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { FullPlayerState } from './full-player-state';
import { NowPlayingMetadataService } from './now-playing-metadata.service';
import type { Media } from '../api/media.service';
import { SessionSyncService } from '../session-sync.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { parseDeviceLabel } from '../../utils/format-device-label';
import { launchPickFor, type LaunchTracks } from '../track-manager.service';
import { launchTracksToWire, RemoteService, snapshotToWire } from '../remote.service';
import { ToastService } from '../toast.service';
import type { LocalOutput, MusicSnapshot, PlaybackOutput, PlaybackSnapshot, VideoHandoff } from './playback-output';

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

/** What the cast or remote output last held, by the kind of player it came from. */
type Away = { kind: 'video'; snapshot: PlaybackSnapshot } | { kind: 'music'; snapshot: MusicSnapshot };

export type OutputKind = 'local' | 'cast' | 'remote';

export type PlaybackCommand =
  | { type: 'toggle' }
  | { type: 'seek'; at: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'item'; index: number }
  | { type: 'enqueue'; tracks: readonly MusicTrackRequest[]; where: 'next' | 'last' }
  | { type: 'queue'; tracks: readonly MusicTrackRequest[] };

/** `drives`: does a party drive that player; `external`: a start from outside the party, refused (and said) while one does. */
export type PartyQuery = { type: 'drives' } | { type: 'external' };
export type PartyPlayer = 'video' | 'audio';

/** Takes a command for the active party; false when it did not. */
export type PartyRouter = (c: PlaybackCommand | PartyQuery, player: PartyPlayer) => boolean;

/** Owns where playback is happening: which output is active and where transport commands go. */
@Injectable({ providedIn: 'root' })
export class PlaybackSession {
  // Resolved on first use, so injecting the session pulls in neither the targets nor the party.
  private readonly injector = inject(Injector);
  private readonly party = () => this.injector.get(PartyService);
  private readonly castSvc = () => this.injector.get(CastService);
  private readonly castPlayer = () => this.injector.get(CastPlayerService);
  private readonly audio = () => this.injector.get(AudioPlayerService);
  private readonly musicCast = () => this.injector.get(MusicCastOutput);
  private readonly remoteSvc = () => this.injector.get(RemoteService);
  private readonly router = () => this.injector.get(Router);
  private readonly sync = () => this.injector.get(SessionSyncService);

  private readonly local = signal<LocalOutput | null>(null);
  private moving: Promise<boolean> | null = null;
  private wasCasting = false;
  private wasAway = false;
  /** Set by `stopControlling`: that return to this device is deliberate and must not resume it. */
  private releasing = false;
  private watchReturns: EffectRef | null = null;
  /** What the cast or remote output last held: once it is gone, its own position reads nothing. */
  private away: Away | null = null;
  private readonly partyRouter = signal<PartyRouter | null>(null);
  /** File the output already holds, set by whoever opens the player route on it. */
  private opened = 0;

  readonly partyActive = computed(() => this.party().drives());

  /** The remote target while remoting, the cast receiver while connected, else the registered local output. */
  readonly output = computed<PlaybackOutput | null>(() => {
    const kind = this.kind();
    if (kind === 'remote') return this.injector.get(RemotePlaybackTarget);
    return kind === 'cast' ? this.injector.get(CastPlaybackTarget) : this.local();
  });

  private readonly fullPlayer = inject(FullPlayerState);
  /** The video player is open on the account session's owner, with no device selected. */
  readonly viewing = computed(() => this.fullPlayer.open() === 'video' && this.fullPlayer.remote());

  readonly kind = computed<OutputKind>(() =>
    this.injector.get(RemotePlaybackTarget).isConnected() || this.viewing()
      ? 'remote'
      : this.injector.get(CastPlaybackTarget).isConnected()
        ? 'cast'
        : 'local',
  );
  /** What an open video view does once the account session moves on: `audio` hands over to the audio player, `none` closes; null follows the item. */
  readonly viewEnd = computed<'audio' | 'none' | null>(() => {
    const sync = this.sync();
    // A claim in flight is replacing the view: closing it would cancel that navigation.
    if (!this.viewing() || sync.claimPending()) return null;
    const s = sync.session();
    if (!s || !sync.observedOwnerTargetId() || sync.isReading(s)) return 'none';
    if (sync.isAudio(s)) return 'audio';
    return s.item.mediaFileId ? null : 'none';
  });
  readonly isLocal = computed(() => this.kind() === 'local');

  /** Following the account session's owner while this device plays nothing itself or elsewhere. */
  readonly observing = computed(() => this.kind() === 'local' && this.injector.get(RemotePlaybackTarget).isObserving());

  /** Display metadata of what the cast, remote or observed output plays; null while local or loading. */
  readonly nowPlaying = inject(NowPlayingMetadataService).track(() => {
    const observing = this.observing();
    if (this.kind() === 'local' && !observing) return null;
    const { mediaId, episodeId, itemId } = (observing ? this.injector.get(RemotePlaybackTarget) : this.output()!).item();
    return mediaId ? { mediaId, episodeId, itemId } : null;
  });

  /** Name of the device playing, null while local and not observing one. */
  readonly deviceName = computed<string | null>(() => {
    const kind = this.kind();
    const translate = this.injector.get(TranslateService);
    if (kind === 'cast') {
      return this.castSvc().castDevices().find((d) => d.connected)?.name ?? 'Chromecast';
    }
    if (kind !== 'remote' && !this.observing()) return null;
    const t = this.remoteSvc().observedTarget();
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
    // A session that outlived the renderer is rejoined as soon as a bridge hands its state back.
    effect(() => {
      if (this.castSvc().resumedState()) untracked(() => this.rejoin());
    });
    // An audio view follows an owner that now plays a video into the video player.
    effect(() => {
      if (this.fullPlayer.open() !== 'audio' || !this.fullPlayer.remote()) return;
      const sync = this.sync();
      const s = sync.session();
      const item = s && sync.videoItem(s);
      if (!s || !item || sync.isAudio(s) || sync.isReading(s) || !sync.observedOwnerTargetId()) return;
      untracked(() => this.viewObserved(item));
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
    this.partyRouter.set(router);
    return () => this.partyRouter.update((cur) => (cur === router ? null : cur));
  }

  /** The party's answer for a player; false when no party router is registered. */
  toParty(c: PlaybackCommand | PartyQuery, player: PartyPlayer): boolean {
    return this.partyRouter()?.(c, player) ?? false;
  }

  /** True when a party or a non-local output took the command; false leaves the local player to act on it. */
  command(c: PlaybackCommand): boolean {
    if (this.partyActive() && this.toParty(c, 'video')) return true;
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

  /** Whether the playing item can be loaded on `deviceId`; only a remote target can refuse it. */
  canMoveTo(kind: OutputKind, deviceId?: string): boolean {
    if (kind !== 'remote' || !deviceId) return true;
    if (this.transfersTo(deviceId)) return true;
    if (this.isLocal() && !this.local() && this.audio().holds()) return false;
    const fileId = this.output()?.snapshot()?.item.fileId;
    return !fileId || this.remoteSvc().canLoad(deviceId, fileId);
  }

  /** Whether a move to `deviceId` hands the account session over, which carries the queue: music held here,
   *  or a session this device follows. Video loads on the device directly. */
  transfersTo(deviceId: string): boolean {
    const sync = this.sync();
    const remote = this.remoteSvc();
    const s = sync.session();
    if (!s || !sync.canTransfer() || this.local() || this.viewing() || !remote.canLoad(deviceId, s.item.mediaFileId)) return false;
    if (!sync.parked() && s.owner.targetId === deviceId) return false;
    if (this.audio().holds()) return !this.toParty({ type: 'drives' }, 'audio');
    return sync.role() === 'observer' && this.isLocal();
  }

  /** The only handoff between outputs. False when refused (TV, nothing to hand over, a target that takes no load) or failed. */
  moveTo(kind: OutputKind, deviceId?: string): Promise<boolean> {
    if (this.injector.get(DeviceService).isTv() || !this.canMoveTo(kind, deviceId)) return Promise.resolve(false);
    if (this.moving) return this.moving;
    const from = this.kind();
    // Another remote device is a switch too, not only another kind of output.
    const switching =
      from !== 'local' && (from !== kind || (kind === 'remote' && deviceId !== this.remoteSvc().selectedTargetId()));
    const run =
      kind === 'local'
        ? this.toLocal()
        : kind === 'remote' && deviceId && this.transfersTo(deviceId)
          ? this.transfer(deviceId)
          : switching
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
    // A view keeps kind remote, so no return to local follows to consume the flag.
    this.releasing = !this.viewing();
    this.remoteSvc().selectTarget(null);
    this.local()?.disconnect();
  }

  /** Opens an item on the active output: loaded there without a local engine, else the player route. */
  async play(item: PlayItem, opts: PlayOptions = {}): Promise<OutputKind> {
    const kind = this.kind();
    const startAt = opts.fromStart ? 0 : undefined;
    if (kind === 'remote') {
      const remote = this.remoteSvc();
      const targetId = remote.observedTargetId();
      if (!targetId) return kind;
      void remote.send(targetId, {
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

  /** Opens the video player on the account session's owner, without selecting its device. */
  viewObserved(item: { fileId: number; mediaId: number; episodeId?: number }): void {
    this.fullPlayer.show('video', true);
    this.openPlayer(item);
  }

  /** The route of a view that `viewEnd` ended is closing: the audio family's player takes the view over. */
  handOverView(to: 'audio' | 'none'): void {
    if (to === 'audio') this.fullPlayer.show('audio', true);
  }

  /** The local video route is up: it owns the full player, as a view when it was opened on the observed session. */
  beginRoute(): void {
    this.fullPlayer.show('video', this.viewing());
  }

  /** The player route is gone: a view of another device's playback ends with it. */
  endView(): void {
    if (this.fullPlayer.open() === 'video') this.fullPlayer.hide();
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
    const held = this.sync().session();
    const observed = held?.item.mediaId === mediaId ? (held.item.mediaFileId ?? 0) : 0;
    const fileId = kind === 'cast' ? this.castPlayer().mediaFileId() : (this.remoteSvc().targetState()?.mediaFileId || observed);
    return fileId && mediaId ? { fileId, mediaId, episodeId } : null;
  });

  private activeLocal(): LocalOutput | AudioPlayerService {
    return this.local() ?? this.audio();
  }

  private async toCast(deviceId?: string): Promise<boolean> {
    const cast = this.castSvc();
    if (!cast.isConnected() && !(await this.connectCast(deviceId))) return false;
    // No video player mounted (opening one closes the audio player): the audio player is what plays here.
    const handoff = await this.activeLocal().release();
    if (!handoff) return true;
    await (handoff.kind === 'music' ? this.musicCast().start(handoff) : this.castVideo(handoff));
    return true;
  }

  private async castVideo(handoff: VideoHandoff): Promise<void> {
    const cp = this.castPlayer();
    if (handoff.resolveSubtitle) {
      const sub = await cp.resolveStartSubtitle(
        handoff.cast.subtitles, handoff.cast.mediaFileId, handoff.cast.mediaId, handoff.audioLanguage,
      );
      handoff.cast.activeSubtitleId = sub?.id ?? null;
    }
    cp.startCast(handoff.cast);
    // The cast ladder comes from the cast profile's own playback-info, not the browser one.
    const { position, paused } = handoff.snapshot;
    await cp.reloadCastStream(position, !paused, handoff.cast.activeQualityId);
    const sid = handoff.localSessionId;
    if (sid && sid !== cp.liveSessionId()) void this.injector.get(StreamingApiService).stopSession(sid).catch(() => {});
  }

  private async transfer(deviceId: string): Promise<boolean> {
    await this.sync().transferTo(deviceId);
    return true;
  }

  private async toRemote(targetId?: string): Promise<boolean> {
    const local = this.local();
    if (!targetId || !local) return false;
    const handoff = await local.release();
    if (!handoff) return false;
    // Until the target reports, what it was handed is the way back here.
    this.away = { kind: 'video', snapshot: handoff.snapshot };
    const remote = this.remoteSvc();
    remote.selectTarget(targetId);
    void remote.send(targetId, snapshotToWire(handoff.snapshot));
    this.stopStream(handoff.localSessionId);
    return true;
  }

  /** Another device took the account session: the local engine unloads in place and the open route becomes the view of the new owner. */
  async yieldToView(): Promise<boolean> {
    if (!this.isLocal()) return false;
    const handoff = await this.local()?.release();
    if (!handoff) return false;
    this.fullPlayer.handTo('video', true);
    this.stopStream(handoff.localSessionId);
    return true;
  }

  private stopStream(sid: string | undefined): void {
    if (sid) void this.injector.get(StreamingApiService).stopSession(sid).catch(() => {});
  }

  /** Moves playback between two other devices without the local engine starting in between. */
  private async switchAway(kind: 'cast' | 'remote', deviceId?: string): Promise<boolean> {
    const from = this.output();
    const snap = from?.snapshot();
    if (!from || !snap || (kind === 'remote' && !deviceId)) return false;
    if (kind === 'cast') {
      if (!(await this.connectCast(deviceId))) return false;
      this.leave(from);
      await this.castPlayer().quickStart({
        mediaFileId: snap.item.fileId,
        mediaId: snap.item.mediaId,
        episodeId: snap.item.episodeId,
        startTime: snap.position,
        tracks: snap.tracks,
        autoplay: !snap.paused,
      });
      return true;
    }
    this.leave(from);
    const remote = this.remoteSvc();
    remote.selectTarget(deviceId!);
    void remote.send(deviceId!, snapshotToWire(snap));
    return true;
  }

  /** Only one device plays: a remote device left behind closes its player, a Cast session ends with its receiver. */
  private leave(from: PlaybackOutput): void {
    if (from === this.injector.get(RemotePlaybackTarget)) from.stopPlayback();
    from.disconnect();
  }

  private async toLocal(): Promise<boolean> {
    const local = this.local();
    const from = this.output();
    if (!local || !from || from === local) return false;
    const snap = from.snapshot() ?? (this.away?.kind === 'video' ? this.away.snapshot : null);
    if (!snap) return false;
    // The account session's owner is superseded instead of stopped: it stays open as the view of this device.
    const sync = this.sync();
    const owner = sync.observableOwner();
    const takeover = from === this.injector.get(RemotePlaybackTarget) && !!owner && owner === this.remoteSvc().observedTargetId();
    if (takeover) from.disconnect();
    else this.leave(from);
    this.fullPlayer.handTo('video', false);
    if (takeover) await sync.handOver(() => local.resume(snap));
    else await local.resume(snap);
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

  /** Restores the session a native or desktop sender kept alive; the player route awaits this before it launches locally. */
  async rejoinCast(): Promise<void> {
    await this.castSvc().settled;
    this.rejoin();
  }

  private rejoin(): void {
    const state = this.castSvc().resumedState();
    if (!state) return;
    if (state.kind === 'music') this.musicCast().adopt(state as unknown as MusicCastState);
    else this.castPlayer().adopt(state);
  }

  private receiverBusy(): boolean {
    return this.castPlayer().hasMedia() || this.musicCast().hasMedia();
  }

  private onCastConnected(): void {
    this.watchReturns ??= this.watchReturnsToLocal();
    this.rejoin();
    const local = this.activeLocal();
    if (this.moving || !local.holds()) return;
    // A receiver that already plays keeps its media: only this device falls silent.
    if (this.receiverBusy()) local.stepAside();
    else void this.moveTo('cast');
  }

  /** Any way back to this device that `moveTo` did not take (receiver lost, "stop controlling", the mini-bar's
   *  close) restarts the local player where the other output was. Created on first attach or connect: it reads the targets. */
  private watchReturnsToLocal() {
    return effect(
      () => {
        const away = this.kind() !== 'local';
        const o = this.output();
        if (away && o) this.away = this.awayState(o);
        untracked(() => {
          if (away === this.wasAway) return;
          this.wasAway = away;
          if (!away) this.onBackToLocal();
        });
      },
      { injector: this.injector },
    );
  }

  /** Music on the receiver is read fresh every time (null once it is closed); a video keeps its last position. */
  private awayState(o: PlaybackOutput): Away | null {
    const music = this.musicCast();
    if (music.active()) {
      const snapshot = music.snapshot();
      return snapshot && { kind: 'music', snapshot };
    }
    const prev = this.away?.kind === 'video' ? this.away : null;
    const s = o.snapshot();
    return s ? { kind: 'video', snapshot: { ...s, position: s.position || prev?.snapshot.position || 0 } } : prev;
  }

  private onBackToLocal(): void {
    const releasing = this.releasing;
    this.releasing = false;
    const away = this.away;
    this.away = null;
    if (!away || this.moving || releasing) return;
    if (away.kind === 'music') void this.audio().resume(away.snapshot);
    else void this.local()?.resume(away.snapshot);
  }
}
