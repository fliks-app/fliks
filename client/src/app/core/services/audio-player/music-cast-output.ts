import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from '../auth.service';
import { CastPlayerService } from '../cast-player.service';
import { CastService, castMixUrl, type CastMediaInfo, type CastMixSource } from '../cast.service';
import { NowPlayingMetadataService } from '../playback/now-playing-metadata.service';
import { ServerConfigService } from '../server-config.service';
import { SERVER_SINCE, ServerVersionService } from '../server-version.service';
import { ToastService } from '../toast.service';
import { StreamingApiService, type PlaybackInfoResponse } from '../api/streaming-api.service';
import type { StemKind } from '../api/karaoke.models';
import type { MusicTrackRequest, Repeat } from './music-queue';
import type { MusicHandoff, MusicSnapshot } from '../playback/playback-output';
import type { StemMode } from './stem-mix';

export type ResumeQueue = { itemIds: number[]; index: number; shuffle: boolean; repeat: Repeat };

/** Saved with kind `music`; `mediaId` and `mediaFileId` are what a desktop relaunch matches against the receiver. */
export interface MusicCastState {
  mediaId: number;
  mediaFileId: number;
  itemId: number;
  sid: string | null;
  /** The receiver's statuses carry no stem: the state does. */
  stem: StemKind | 'mix' | null;
  queue: ResumeQueue | null;
  stemMode: StemMode;
  vocalLevel: number;
}

/** What the receiver plays of ours, as the audio player takes it over. */
export interface MusicAdoption {
  itemId: number;
  sid: string | null;
  mediaFileId: number;
  queue: ResumeQueue | null;
  stemMode: StemMode;
  vocalLevel: number;
}

/** What the audio player lends its cast output. */
export interface MusicCastHost {
  /** The queue track playing, reactive. */
  current(): MusicTrackRequest | null;
  /** The play order, reactive; null outside music. */
  queue(): ResumeQueue | null;
  karaoke(): { mode: StemMode; level: number };
  /** Where the receiver is and whether it plays, as of now. */
  playhead(): { position: number; playing: boolean };
  position(seconds: number): void;
  playState(playing: boolean): void;
  buffering(on: boolean): void;
  ended(): void;
  /** The receiver moved on to the queued track by itself. */
  advanced(req: MusicTrackRequest, info: PlaybackInfoResponse): void;
  /** The track was loaded again (stem to original): a new server session. */
  reloaded(info: PlaybackInfoResponse): void;
  stemsFailed(): void;
  /** Plays the snapshot's track on the receiver. */
  startOnCast(s: MusicSnapshot): Promise<void>;
  /** Takes over the receiver's track; false when this device plays something else. */
  adopt(a: MusicAdoption): Promise<boolean>;
  /** The adopted media is active: its stems can be looked up. */
  adopted(): void;
  /** Another sender's media replaced ours on the receiver. */
  lost(): void;
}

/** The server's mix of a stem file, as a receiver source id. */
const mixId = (fileId: number) => `karaoke-${fileId}`;

/** Music playing on a Cast receiver: loads, up-next queue, end/advance detection and karaoke stems. */
@Injectable({ providedIn: 'root' })
export class MusicCastOutput {
  private readonly cast = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);
  private readonly streaming = inject(StreamingApiService);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly serverVersion = inject(ServerVersionService);
  private readonly nowPlaying = inject(NowPlayingMetadataService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  private readonly host = signal<MusicCastHost | null>(null);
  private readonly _active = signal(false);
  /** A resumed state armed: the next status of the user's own music on the receiver is adopted. */
  private readonly pending = signal<MusicCastState | null>(null);
  /** The receiver ids of the last LOAD or advance, which the resume state carries. */
  private readonly loaded = signal<Pick<MusicCastState, 'mediaId' | 'mediaFileId' | 'itemId' | 'sid'> | null>(null);
  readonly isConnected = this.cast.isConnected;
  readonly deviceName = this.cast.deviceName;
  /** This device's music plays on the receiver. */
  readonly active = this._active.asReadonly();
  /** Ours plays on the receiver, or a resumed state waits to take it back. */
  readonly hasMedia = computed(() => this._active() || this.pending() !== null);

  /** Bumped by every call that makes an in-flight load or prepare stale. */
  private generation = 0;
  /** The next track, queued on the receiver after the playing one. */
  private next: { req: MusicTrackRequest; info: PlaybackInfoResponse } | null = null;
  /** The track a queueing was started for, so one track is prepared once. */
  private tried: MusicTrackRequest | null = null;
  /** The receiver reported the playing track under way, so its end can be told from the status of a move to it. */
  private started = false;
  /** A status named our track: media without an item id then means another sender replaced it. */
  private seen = false;
  private stemFile: number | null = null;
  /** Content type of each stem the receiver may load. */
  private stemTypes: Partial<Record<StemKind, string>> = {};
  /** What the receiver plays in place of the track: a stem, or its mix of the stems. */
  private readonly stemKind = signal<StemKind | 'mix' | null>(null);
  private stemRun: Promise<void> = Promise.resolve();

  constructor() {
    effect(() => {
      const host = this.host();
      const time = this.cast.currentTime();
      if (host && this.active()) untracked(() => host.position(time));
    });
    effect(() => {
      const host = this.host();
      const paused = this.cast.isPaused();
      if (host && this.active()) untracked(() => host.playState(!paused));
    });
    effect(() => {
      const host = this.host();
      const buffering = this.cast.buffering();
      if (host && this.active()) untracked(() => host.buffering(buffering));
    });
    effect(() => {
      const host = this.host();
      const ended = this.cast.ended();
      const media = this.cast.receiverMedia();
      if (host && this.active() && host.current()) untracked(() => this.onStatus(host, ended, media));
    });
    effect(() => {
      const host = this.host();
      const pending = this.pending();
      const media = this.cast.receiverMedia();
      if (host && pending && !this._active() && this.cast.isConnected()) untracked(() => void this.follow(host, pending, media));
    });
    effect(() => {
      const host = this.host();
      const loaded = this.loaded();
      if (!host || !loaded || !this.active()) return;
      const state: MusicCastState = { ...loaded, stem: this.stemKind(), queue: host.queue(), stemMode: host.karaoke().mode, vocalLevel: host.karaoke().level };
      untracked(() => this.cast.saveResumeState('music', state));
    });
    let wasConnected = false;
    effect(() => {
      const connected = this.cast.isConnected();
      untracked(() => {
        if (wasConnected && !connected) this.dropPending();
        wasConnected = connected;
      });
    });
  }

  attach(host: MusicCastHost): () => void {
    this.host.set(host);
    return () => this.host.set(null);
  }

  /** Loads `t` on the receiver; null when the load failed or `current` went false meanwhile. */
  async load(t: MusicTrackRequest, autoplay: boolean, startAt: number, current: () => boolean): Promise<PlaybackInfoResponse | null> {
    const generation = ++this.generation;
    this.started = false;
    this.seen = false;
    this.nowPlaying.primeTracks([t]);
    const info = await this.loadTrack(t, autoplay, startAt, current);
    if (!info) return null;
    if (current() && generation === this.generation) {
      this._active.set(true);
      return info;
    }
    // The caller moved on: end the orphan LOAD, unless a newer load of this output owns the receiver.
    if (info.sessionId) void this.streaming.stopSession(info.sessionId).catch(() => undefined);
    if (!this.active()) this.cast.stop();
    return null;
  }

  /** The queue track with the receiver's position and play state, as the audio player last saw them. */
  snapshot(): MusicSnapshot | null {
    const host = this.host();
    const track = host?.current();
    if (!host || !track) return null;
    const { position, playing } = host.playhead();
    return { track, position, paused: !playing, karaoke: host.karaoke() };
  }

  start(h: MusicHandoff): Promise<void> {
    return this.host()?.startOnCast(h.snapshot) ?? Promise.resolve();
  }

  play(): void {
    this.cast.play();
  }

  pause(): void {
    this.cast.pause();
  }

  toggle(): void {
    this.cast.togglePlayPause();
  }

  seek(seconds: number): void {
    this.cast.seek(seconds);
  }

  /** Stops the receiver when this output plays there, then forgets it. */
  stop(): void {
    if (this.active()) this.cast.stop();
    this.release();
  }

  /** Ends the Cast session, which stops the receiver with it. */
  leave(): void {
    this.release();
    this.cast.disconnect();
  }

  /** Forgets the receiver media without touching it. */
  release(): void {
    this.generation++;
    this._active.set(false);
    this.seen = false;
    this.pending.set(null);
    this.loaded.set(null);
    this.cast.clearResumeState('music');
  }

  /** An armed state that cannot match is dropped with the saved one, which `rejoin` would arm again. */
  private dropPending(): void {
    this.pending.set(null);
    this.cast.clearResumeState('music');
  }

  /** Arms the adoption of the receiver's music of this user, from the state a bridge handed back. */
  adopt(state: MusicCastState): void {
    if (!this.active()) this.pending.set(state);
  }

  /** The receiver moves on to `next` by itself at the end of the playing track, with no LOAD in between. */
  queueNext(next: MusicTrackRequest): void {
    if (this.tried === next) return;
    this.tried = next;
    const generation = this.generation;
    this.nowPlaying.primeTracks([next]);
    void this.prepareTrack(next)
      .then(({ pi, media }) => {
        // The receiver names the track it plays by its session: one without could not be followed.
        if (generation !== this.generation || !this.active() || !pi.sessionId) {
          if (pi.sessionId) void this.streaming.stopSession(pi.sessionId).catch(() => undefined);
          return;
        }
        this.next = { req: next, info: pi };
        this.cast.queueNext(media);
      })
      .catch(() => undefined);
  }

  hasNext(): boolean {
    return this.next !== null;
  }

  /** Takes the queued track off the receiver and ends its session. */
  dropNext(): void {
    this.generation++;
    this.tried = null;
    const queued = this.next;
    this.next = null;
    if (!queued) return;
    this.cast.queueNext(null);
    void this.streaming.stopSession(queued.info.sessionId!).catch(() => undefined);
  }

  setStemSource(fileId: number, types: Partial<Record<StemKind, string>>): void {
    this.stemFile = fileId;
    this.stemTypes = types;
  }

  clearStems(): void {
    this.stemFile = null;
    this.stemKind.set(null);
  }

  /** One switch at a time, each from the state when it runs: a second LOAD would replace the first and fail it. */
  applyStems(): Promise<void> {
    return (this.stemRun = this.stemRun.then(() => this.switchStem()).catch(() => undefined));
  }

  /** A stem mode plays the receiver's mix of the instrumental and the vocals at the vocal level (a server without
   *  stem PCM: the guide stem, else the instrumental); `original` the track again. */
  private async switchStem(): Promise<void> {
    const host = this.host();
    const req = host?.current();
    const file = this.stemFile;
    if (!host || !req || file === null) return;
    const { mode, level } = host.karaoke();
    const mixed = this.serverVersion.supports(SERVER_SINCE.stemPcm);
    const kind = mode === 'original' ? null : mixed ? 'mix' : mode === 'guide' && 'guide' in this.stemTypes ? 'guide' : 'instrumental';
    if (kind === this.stemKind()) return kind === 'mix' ? this.setMixVocals(file, level) : undefined;
    // The LOAD below empties the receiver's queue.
    this.dropNext();
    const generation = this.generation;
    const { position, playing } = host.playhead();
    const current = () => generation === this.generation;
    if (kind) {
      const loaded = kind === 'mix'
        ? await this.castMix(req, file, level, position, playing, current)
        : await this.castStem(req, file, kind, this.stemTypes[kind] ?? 'audio/ogg', position, playing, current);
      if (!loaded) return void (current() && host.stemsFailed());
    } else {
      const info = await this.loadTrack(req, playing, position, current);
      if (!info) return void (current() && host.stemsFailed());
      host.reloaded(info);
    }
    if (current()) this.stemKind.set(kind);
  }

  /** A status names the media it reports: the queued track the receiver moved on to, the track playing here, or a stale one. */
  private onStatus(host: MusicCastHost, ended: boolean, media: Record<string, unknown> | null): void {
    if (!media) return;
    const next = this.next;
    if (next && media['sid'] === next.info.sessionId) {
      this.started = false;
      this.seen = true;
      this.next = null;
      this.tried = null;
      this.loaded.set({ mediaId: next.req.mediaId, mediaFileId: next.info.mediaFileId, itemId: next.req.itemId, sid: next.info.sessionId ?? null });
      return host.advanced(next.req, next.info);
    }
    if (typeof media['itemId'] !== 'number') return this.seen ? host.lost() : undefined;
    if (media['itemId'] !== host.current()?.itemId) return;
    this.seen = true;
    // The queue reports its move to a track as that track IDLE and finished: only an end after it played counts.
    if (!ended) this.started = true;
    else if (this.started) {
      this.started = false;
      host.ended();
    }
  }

  /** Takes the receiver's music of this user once a resumed state armed it; the state's mix survives only for its own item. */
  private async follow(host: MusicCastHost, pending: MusicCastState, media: Record<string, unknown> | null): Promise<void> {
    const itemId = media?.['itemId'];
    const mediaFileId = media?.['mediaFileId'];
    if (!media) return;
    if (typeof itemId !== 'number' || typeof mediaFileId !== 'number' || media['userId'] !== this.auth.user()?.id) return this.dropPending();
    const same = itemId === pending.itemId;
    const q = pending.queue;
    const upNext = q && (q.itemIds[q.index + 1] ?? (q.repeat === 'all' ? q.itemIds[0] : undefined));
    if (!same && itemId !== upNext) return this.dropPending();
    this.pending.set(null);
    const sid = same ? pending.sid : typeof media['sid'] === 'string' ? media['sid'] : null;
    const stemMode = same ? pending.stemMode : 'original';
    const adopted = await host.adopt({ itemId, sid, mediaFileId, queue: pending.queue, stemMode, vocalLevel: same ? pending.vocalLevel : 0 });
    if (!adopted) return;
    if (!this.cast.isConnected()) return host.lost();
    this.seen = true;
    this.started = false;
    this.stemKind.set(same ? pending.stem : null);
    this.loaded.set({ mediaId: typeof media['mediaId'] === 'number' ? media['mediaId'] : pending.mediaId, mediaFileId, itemId, sid });
    this._active.set(true);
    host.adopted();
  }

  /** Replaces the receiver's media by a karaoke stem of the playing track (file-bound token), at `position`. */
  private async castStem(
    t: MusicTrackRequest,
    fileId: number,
    kind: StemKind,
    contentType: string,
    position: number,
    autoplay: boolean,
    current: () => boolean,
  ): Promise<boolean> {
    const url = await this.stemUrl(fileId, kind);
    return !!url && current() && this.loadStem(t, fileId, url, contentType, kind, position, autoplay);
  }

  /** Replaces the receiver's media by its mix of the instrumental and the vocals of `t`, the vocals at `vocals`. */
  private async castMix(t: MusicTrackRequest, fileId: number, vocals: number, position: number, autoplay: boolean, current: () => boolean): Promise<boolean> {
    const sources = await this.karaokeMix(fileId, vocals);
    if (!sources || !current()) return false;
    await this.cast.setMix(mixId(fileId), sources);
    return current() && this.loadStem(t, fileId, castMixUrl(mixId(fileId)), 'audio/mp4', 'mix', position, autoplay);
  }

  /** A new vocal level for the mix the receiver plays: it remixes what it buffered, with no reload. */
  private async setMixVocals(fileId: number, vocals: number): Promise<void> {
    const sources = await this.karaokeMix(fileId, vocals);
    if (sources) await this.cast.setMix(mixId(fileId), sources);
  }

  private async karaokeMix(fileId: number, vocals: number): Promise<CastMixSource[] | null> {
    const [instrumental, voice] = await Promise.all([this.stemUrl(fileId, 'instrumental/pcm'), this.stemUrl(fileId, 'vocals/pcm')]);
    return instrumental && voice ? [{ url: instrumental, gain: 1 }, { url: voice, gain: vocals }] : null;
  }

  private async loadStem(t: MusicTrackRequest, fileId: number, url: string, contentType: string, stem: string, position: number, autoplay: boolean) {
    this.cast.setCastStreamBase((await this.auth.getCastInfo()).streamBaseUrl);
    try {
      await this.cast.loadMedia({
        url,
        contentType,
        title: t.title,
        subtitle: t.artists,
        posterUrl: t.coverUrl ? this.serverConfig.resolveUrl(t.coverUrl) : undefined,
        mediaId: t.mediaId,
        itemId: t.itemId,
        stem,
        mediaFileId: fileId,
        userId: this.auth.user()?.id,
        currentTime: position,
        autoplay,
      });
      this.loaded.update((l) => ({ mediaId: t.mediaId, itemId: t.itemId, mediaFileId: fileId, sid: l?.sid ?? null }));
      return true;
    } catch (err) {
      console.error('[cast] stem LOAD failed', err);
      return false;
    }
  }

  private async stemUrl(fileId: number, path: string): Promise<string | null> {
    const token = await this.auth.ensureStreamToken(fileId);
    return token && `${this.streaming.absoluteUrl(`/api/media-files/${fileId}/stems/${path}`)}?token=${encodeURIComponent(token)}`;
  }

  /** Loads one music track on the receiver; returns the server's playback info, or null when the load failed. */
  private async loadTrack(t: MusicTrackRequest, autoplay: boolean, startAt: number, current: () => boolean) {
    const { pi, media } = await this.prepareTrack(t, startAt);
    if (!current()) {
      if (pi.sessionId) void this.streaming.stopSession(pi.sessionId).catch(() => undefined);
      return null;
    }
    try {
      await this.cast.loadMedia({ ...media, autoplay });
      this.loaded.set({ mediaId: t.mediaId, mediaFileId: pi.mediaFileId, itemId: t.itemId, sid: pi.sessionId ?? null });
      return pi;
    } catch (err) {
      console.error('[cast] LOAD failed', err);
      if (pi.sessionId) void this.streaming.stopSession(pi.sessionId).catch(() => undefined);
      this.toast.error(this.translate.instant('cast.error.load_failed'));
      return null;
    }
  }

  /** The server's playback info of a music track and the receiver media that plays it. */
  private async prepareTrack(t: MusicTrackRequest, startAt = 0): Promise<{ pi: PlaybackInfoResponse; media: CastMediaInfo }> {
    const [pi, castInfo] = await Promise.all([
      this.streaming.getItemPlaybackInfo(t.itemId, this.castPlayer.getCastDeviceProfile(), { startAt }),
      this.auth.getCastInfo(),
    ]);
    this.cast.setCastStreamBase(castInfo.streamBaseUrl);
    const { url, contentType } = this.streaming.buildAbsolutePlayUrl(pi, castInfo.token, { sid: pi.sessionId });
    const media: CastMediaInfo = {
      url,
      contentType,
      title: t.title,
      subtitle: t.artists,
      posterUrl: t.coverUrl ? this.serverConfig.resolveUrl(t.coverUrl) : undefined,
      mediaId: t.mediaId,
      itemId: t.itemId,
      mediaFileId: pi.mediaFileId,
      sid: pi.sessionId,
      userId: this.auth.user()?.id,
      currentTime: startAt,
    };
    return { pi, media };
  }
}
