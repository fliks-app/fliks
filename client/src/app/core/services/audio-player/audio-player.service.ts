import { Injectable, Injector, computed, effect, inject, runInInjectionContext, signal, untracked } from '@angular/core';
import { CastService } from '../cast.service';
import { CastPlayerService } from '../cast-player.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { BrowserDeviceProfileService, type DeviceProfile } from '../browser-device-profile.service';
import { Capacitor } from '@capacitor/core';
import { MediaService } from '../api/media.service';
import { StreamingApiService, type PlaybackInfoResponse } from '../api/streaming-api.service';
import { PlaybackQueueService } from '../playback-queue.service';
import { DownloadCacheService } from '../download-cache.service';
import { NetworkService } from '../network.service';
import { OfflineBookStoreService } from '../offline-book-store.service';
import { OfflinePlaybackSyncService } from '../offline-playback-sync.service';
import { StorageScopeService } from '../storage-scope.service';
import { asBookMedia } from '../api/book-media';
import { mediaKeyAction } from '../../../features/player/player-keymap';
import {
  NATIVE_AUDIO,
  type NativeAudioCommand,
  type NativeAudioPosition,
  type NativeAudioQueue,
  type NativeAudioState,
  type NativeAudioTrack,
  type NativeAudioTrackRequest,
} from '../../plugins/audio-player.plugin';
import { SessionSyncService, type AccountSession, type SupersededPlayback } from '../session-sync.service';
import { RemoteService } from '../remote.service';
import { MusicApiService, alignTrackRows } from '../api/music-api.service';
import type { RemoteCommand, WireQueue } from '../sse.service';
import { KaraokeApiService } from '../api/karaoke-api.service';
import { StemMix, mixGains, type StemMode, GUIDE_VOCAL_LEVEL } from './stem-mix';
import type { StemKind } from '../api/karaoke.models';
import { MusicQueue, type MusicTrackRequest, type Repeat } from './music-queue';
import { PREAMP_STEPS, REPLAY_GAINS, replayGainFactor, type ReplayGainMode } from './replay-gain';
import {
  chapterAt,
  chaptersFromParts,
  locate,
  nextChapterStart,
  previousChapterStart,
  type TimelineChapter,
} from './audio-timeline';

/** What the queue plays: one item of an audio edition, shown as a book. */
export interface AudioRequest {
  mediaId: number;
  itemId: number;
  title: string;
  artist?: string;
  coverUrl?: string | null;
  album?: string;
}

export interface AudioBookmark {
  position: number;
  createdAt: number;
}

/** Sleep timer: a wall-clock deadline, or the end of the chapter playing when it was set. */
export type SleepTimer = { kind: 'duration'; endsAt: number; minutes: number } | { kind: 'chapter'; end: number };

/** What a party driving the audio player intercepts; `drives` asks whether it does. */
export type AudioPartyCommand =
  | { type: 'drives' }
  | { type: 'external' }
  | { type: 'toggle' }
  | { type: 'seek'; at: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'item'; index: number };

export type AudioPartyRouter = (c: AudioPartyCommand) => boolean;

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const SKIP_STEPS = [10, 15, 30, 45, 60];

interface PlayPart {
  url: string;
  offset: number;
  duration: number;
}

interface Prefs {
  rate: number;
  skipBack: number;
  skipForward: number;
  replayGain: ReplayGainMode;
  preamp: number;
}

type BeatBody = Parameters<StreamingApiService['updatePlaybackState']>[1];

const BEAT_MS = 15_000;
const STARTING_MAX_MS = 5000;
const PRELOAD_S = 20;
const RESTART_S = 3;
/** Ids a wire queue carries at most (the server and `/api/tracks?ids` cap). */
const WIRE_QUEUE_MAX = 500;
const POSITION_STATE_MS = 1000;
const PREFS_KEY = 'fliks.audio.prefs';
const BOOKMARKS_KEY = 'fliks.audio.bookmarks';

/** The one audio player of the app: an `<audio>` pair driven as a single timeline across the parts of an item, outliving every route. */
@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  private readonly streaming = inject(StreamingApiService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly mediaService = inject(MediaService);
  private readonly bookQueue = inject(PlaybackQueueService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly storage = inject(StorageScopeService);
  private readonly downloads = inject(DownloadCacheService);
  private readonly store = inject(OfflineBookStoreService);
  private readonly network = inject(NetworkService);
  private readonly sync = inject(OfflinePlaybackSyncService);
  private readonly injector = inject(Injector);
  private readonly nativeAudio = inject(NATIVE_AUDIO);
  private readonly auth = inject(AuthService);
  private readonly sessionSync = inject(SessionSyncService);
  private readonly remote = inject(RemoteService);
  private readonly music = inject(MusicApiService);

  private readonly _track = signal<AudioRequest | null>(null);
  private readonly _playing = signal(false);
  private readonly _loading = signal(false);
  /** Autoplay asked, playback not reported yet: the gap after `_loading` ends where the player is neither loading nor playing. */
  private readonly _starting = signal(false);
  private startingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _position = signal(0);
  private readonly _duration = signal(0);
  private readonly _chapters = signal<TimelineChapter[]>([]);
  private readonly _sleep = signal<SleepTimer | null>(null);
  private readonly _sleepLeft = signal(0);
  private readonly _prefs = signal<Prefs>(this.readPrefs());
  private readonly _bookmarks = signal<AudioBookmark[]>([]);
  private readonly _expanded = signal(false);
  private readonly _musicMode = signal(false);
  private readonly _queue = signal<readonly MusicTrackRequest[]>([]);
  private readonly _queueIndex = signal(-1);
  private readonly _shuffle = signal(false);
  private readonly _repeat = signal<Repeat>('off');
  private readonly _ended = signal(false);
  private readonly _buffering = signal(false);
  private readonly _stemMode = signal<StemMode>('original');
  private readonly _vocalLevel = signal(0);
  private readonly _pitch = signal(0);
  private readonly _stemsAvailable = signal(false);

  readonly track = this._track.asReadonly();
  readonly playing = this._playing.asReadonly();
  readonly loading = this._loading.asReadonly();
  /** Seconds on the item timeline. */
  readonly position = this._position.asReadonly();
  readonly duration = this._duration.asReadonly();
  readonly chapters = this._chapters.asReadonly();
  readonly sleep = this._sleep.asReadonly();
  /** Seconds left on a duration timer. */
  readonly sleepLeft = this._sleepLeft.asReadonly();
  readonly bookmarks = this._bookmarks.asReadonly();
  readonly expanded = this._expanded.asReadonly();
  /** True while a track queue plays instead of an audiobook. */
  readonly musicMode = this._musicMode.asReadonly();
  readonly queue = this._queue.asReadonly();
  readonly queueIndex = this._queueIndex.asReadonly();
  readonly shuffle = this._shuffle.asReadonly();
  readonly repeat = this._repeat.asReadonly();
  /** A party's track played to its end: the queue does not advance, the server picks what follows. */
  readonly ended = this._ended.asReadonly();
  readonly buffering = this._buffering.asReadonly();
  readonly stemMode = this._stemMode.asReadonly();
  /** Vocal stem gain, 0 to 1, applied whenever the mode is not `original`. */
  readonly vocalLevel = this._vocalLevel.asReadonly();
  /** Key change in semitones of the playing track; the engine transcodes it, so the stems are dropped while it is not 0. */
  readonly pitch = this._pitch.asReadonly();
  /** True when the playing music track has its stems ready and this player can mix them. */
  readonly stemsAvailable = this._stemsAvailable.asReadonly();
  /** True where the native player cannot mix stems. */
  readonly stemsNative = !!this.nativeAudio && !NATIVE_STEMS.includes(Capacitor.getPlatform());
  readonly replayGain = computed(() => this._prefs().replayGain);
  readonly preamp = computed(() => this._prefs().preamp);
  readonly active = computed(() => this._track() !== null);
  readonly rate = computed(() => this._prefs().rate);
  readonly skipBack = computed(() => this._prefs().skipBack);
  readonly skipForward = computed(() => this._prefs().skipForward);
  readonly chapterIndex = computed(() => chapterAt(this._chapters(), this._position()));

  private els: HTMLAudioElement[] = [];
  private current = 0;
  private parts: PlayPart[] = [];
  private partIndex = 0;
  private preloaded = -1;
  private info: PlaybackInfoResponse | null = null;
  private sessionId: string | undefined;
  private hls: { destroy(): Promise<void> } | null = null;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  private sleepTimer: ReturnType<typeof setInterval> | undefined;
  private lastPositionState = 0;
  private generation = 0;
  /** True while the playing track is on a Cast receiver instead of the local elements. */
  private casting = false;
  private cast: CastService | null = null;
  private readonly mq = new MusicQueue();
  private pre: { req: MusicTrackRequest; info: PlaybackInfoResponse; url: string; parts: PlayPart[] } | null = null;
  private preTried: MusicTrackRequest | null = null;
  private audioCtx: AudioContext | null = null;
  private readonly gainNodes = new Map<HTMLAudioElement, GainNode>();
  private stems: StemMix | null = null;
  private stemsRun = 0;
  private partyRouter: AudioPartyRouter | null = null;
  /** Voice-chat ducking factor, never persisted. */
  private duck = 1;
  private level = 1;
  private muted = false;
  /** True while the native player holds the playing track; it resolves the streams of a music queue itself. */
  private nativeOn = false;
  private nativeReady = false;
  private nativeEnded = false;
  private nativeRate = 1;
  private nativeIndex = -1;
  private routedSent = false;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => this.beatOnExit());
    window.addEventListener('keydown', (e) => this.onMediaKey(e));
    if (this.nativeAudio) void this.attachNative().catch(() => undefined);
    this.remote.registerLoader('audio', (cmd) => this.loadFromRemote(cmd));
    this.remote.validated.subscribe((cmd) => void this.applyRemote(cmd));
    this.sessionSync.registerResumer('audio', (s, positionSeconds) => this.resumeSession(s, positionSeconds));
    this.sessionSync.registerPlayer({
      sessionId: () => this.sessionId,
      active: () => this._track() !== null && (this._playing() || this._loading() || this._starting()),
      yield: () => this.yieldToTakeover(),
      itemId: () => (this.routed({ type: 'drives' }) ? null : (this._track()?.itemId ?? null)),
      report: () => this.beat(),
    });
    let signedIn = !!this.auth.user();
    effect(() => {
      const now = !!this.auth.user();
      if (signedIn && !now) untracked(() => this.dropForSession());
      signedIn = now;
    });
  }

  /** Another device took the account session: the player closes with its position saved and offers to start again. */
  private async yieldToTakeover(): Promise<SupersededPlayback | null> {
    const req = this._track();
    if (!req) return null;
    const positionSeconds = this._position();
    const queue = this._musicMode() ? this.wireQueue() : null;
    await this.close();
    if (!queue) return { title: req.title, positionSeconds, resume: () => this.play(req, { startAt: positionSeconds }) };
    return {
      title: req.title,
      positionSeconds,
      resume: () => this.startQueue(queue, queue.shuffle, queue.repeat, positionSeconds, true),
    };
  }

  /** The account left: its queue goes without a progress beat, which would reach the next account. */
  private dropForSession(): void {
    this.info = null;
    void this.close();
  }

  /** Starts the item, or resumes it when it is the one loaded. */
  async play(req: AudioRequest, opts: { startAt?: number; paused?: boolean } = {}): Promise<void> {
    if (this.blockedByParty()) return;
    if (this._track()?.itemId === req.itemId && this.info) {
      if (this.nativeOn ? !this._playing() : this.el()?.paused) this.toggle();
      return;
    }
    const generation = ++this.generation;
    await this.release();
    this.leaveMusic();
    this._track.set(req);
    this._loading.set(true);
    this._position.set(0);
    this._duration.set(0);
    this._chapters.set([]);
    this._bookmarks.set(this.readBookmarks(req.itemId));
    this.bookQueue.syncTo(req.mediaId);
    try {
      const local = await this.localParts(req.itemId);
      let opened: PlaybackInfoResponse | null = null;
      if (!local || this.network.isOnline()) {
        // Replayed first: the server's playedAt guard orders it against progress from another device.
        if (this.network.isOnline()) await this.sync.flush();
        opened = await this.streaming
          .getItemPlaybackInfo(req.itemId, this.deviceProfile.getProfile())
          .catch((e) => {
            if (!local) throw e;
            return null;
          });
      }
      if (generation !== this.generation) return;
      // A downloaded item plays from the device, with the server's session and resume point when it answers; a position still queued after the replay is the newest.
      const queued = this.sync.queuedPositionFor(req.mediaId, undefined, req.itemId);
      const info = local
        ? ({
            startAtSeconds: this.sync.resumePositionFor(req.mediaId, undefined, req.itemId)?.positionSeconds ?? 0,
            ...opened,
            mediaFileId: opened?.mediaFileId ?? local.mediaFileId,
            playMethod: 'DirectPlay',
            durationSeconds: local.book.durationSeconds,
            chapters: local.book.chapters,
          } as PlaybackInfoResponse)
        : opened!;
      if (queued) info.startAtSeconds = queued.positionSeconds;
      if (opts.startAt !== undefined) info.startAtSeconds = opts.startAt;
      this.info = info;
      this.sessionId = info.sessionId;
      this.parts = local ? local.parts : this.partsOf(info);
      this._duration.set(info.durationSeconds ?? this.parts.reduce((s, p) => s + p.duration, 0));
      this._chapters.set(this.chaptersOf(info));
      this.setupMediaSession(req);
      const start = info.startAtSeconds ?? 0;
      await this.load(start, opts.paused !== true);
    } catch {
      if (generation === this.generation) await this.close();
    } finally {
      if (generation === this.generation) {
        this.markStarting(opts.paused !== true);
        this._loading.set(false);
      }
    }
  }

  private markStarting(autoplay: boolean): void {
    clearTimeout(this.startingTimer);
    const on = autoplay && this._track() !== null && !this._playing();
    this._starting.set(on);
    // A blocked autoplay never reports a play state.
    if (on) this.startingTimer = setTimeout(() => this._starting.set(false), STARTING_MAX_MS);
  }

  /** Plays a track queue from `startIndex`, always from 0:00. */
  async playTracks(tracks: readonly MusicTrackRequest[], startIndex = 0, opts?: { shuffle?: boolean }): Promise<void> {
    if (!tracks.length || this.blockedByParty()) return;
    this.mq.set(tracks, startIndex, opts?.shuffle ?? this._shuffle());
    this.mq.repeat = this._repeat();
    this.syncQueue();
    await this.startMusic(this.mq.current!);
  }

  /** Adds tracks after the current one or at the end; starts them when nothing plays. */
  enqueueTracks(tracks: readonly MusicTrackRequest[], where: 'next' | 'last'): void {
    if (!tracks.length || this.blockedByParty()) return;
    if (!this._musicMode()) return void this.playTracks(tracks);
    if (where === 'next') this.mq.addNext(tracks);
    else this.mq.addLast(tracks);
    this.dropPreload();
    this.syncQueue();
    this.pushQueue();
  }

  /** The next track of the queue, or the next chapter of a book. */
  next(): void {
    if (!this._musicMode()) return this.nextChapter();
    if (this.routed({ type: 'next' })) return;
    const t = this.mq.next(false);
    if (t) this.syncQueue(), void this.goTo(t);
  }

  /** The track a skip in that direction would play, without moving. */
  neighbour(step: 1 | -1): MusicTrackRequest | null {
    // The queue's signal mirrors, read so that a computed caller follows the queue.
    if (!this._musicMode() || this._queueIndex() < 0 || !this._queue().length || !this._repeat()) return null;
    return this.mq.neighbour(step);
  }

  /** Restarts the track past a few seconds, else the previous one. */
  /** `restart` false skips the "past 3 s restarts the track" rule: a remote prev means the previous track. */
  previous(restart = true): void {
    if (!this._musicMode()) return this.previousChapter();
    if (restart && this._position() > RESTART_S) return void this.seek(0);
    if (this.routed({ type: 'prev' })) return;
    const t = this.mq.previous();
    if (t) this.syncQueue(), void this.goTo(t);
    else void this.seek(0);
  }

  playQueueAt(index: number): void {
    if (this.routed({ type: 'item', index })) return;
    const t = this.mq.playAt(index);
    if (t) this.syncQueue(), void this.goTo(t);
  }

  removeFromQueue(index: number): void {
    const removingCurrent = index === this.mq.index;
    this.mq.remove(index);
    this.dropPreload();
    this.syncQueue();
    this.pushQueue();
    if (!removingCurrent) return;
    const t = this.mq.current;
    if (!t) void this.close();
    else if (!this.nativeOn) void this.goTo(t);
  }

  moveInQueue(from: number, to: number): void {
    this.mq.move(from, to);
    this.dropPreload();
    this.syncQueue();
    this.pushQueue();
  }

  setShuffle(on: boolean): void {
    this.mq.setShuffle(on);
    this.dropPreload();
    this.syncQueue();
    this.pushQueue();
  }

  cycleRepeat(): void {
    this.setRepeat(({ off: 'all', all: 'one', one: 'off' } as const)[this.mq.repeat]);
  }

  setRepeat(mode: Repeat): void {
    this.mq.repeat = mode;
    this.dropPreload();
    this.syncQueue();
    if (this.nativeOn) void this.nativeAudio!.setRepeat({ mode: this.mq.repeat });
  }

  setReplayGain(mode: ReplayGainMode): void {
    this.updatePrefs({ replayGain: mode });
    this.applyGains();
  }

  setPreamp(preamp: number): void {
    this.updatePrefs({ preamp });
    this.applyGains();
  }

  /** The party's router for the audio player; the disposer only clears its own registration. */
  setPartyRouter(router: AudioPartyRouter): () => void {
    this.partyRouter = router;
    this.syncRouting();
    return () => {
      if (this.partyRouter === router) this.partyRouter = null;
      this.syncRouting();
    };
  }

  private routed(c: AudioPartyCommand): boolean {
    return this.partyRouter?.(c) ?? false;
  }

  private blockedByParty(): boolean {
    return this.routed({ type: 'external' });
  }

  /** The party opens its track paused: the queue holds just that track, and the group starts it. */
  async openForParty(req: MusicTrackRequest): Promise<void> {
    this.mq.set([req], 0, false);
    this.mq.repeat = 'off';
    this.syncQueue();
    await this.startMusic(req, false);
    this.syncRouting();
  }

  /** True when the loaded track can be seeked: metadata is in and no load is in flight. */
  partyReady(): boolean {
    if (this.nativeOn) return !!this.info && !this._loading() && this.nativeReady;
    const el = this.el();
    return !!el && !!this.info && !this._loading() && !this.casting && el.readyState >= 1;
  }

  /** Plays the loaded track without going through the party. */
  resume(): void {
    if (this.casting) return this.cast!.play();
    if (this.nativeOn) return void this.nativeAudio!.play();
    void this.el()?.play().catch(() => undefined);
  }

  /** Playback speed of the element, which the party nudges to stay in sync. */
  elementRate(): number {
    if (this.nativeOn) return this.nativeRate;
    return this.el()?.playbackRate ?? 1;
  }

  /** A party's rate nudge: never saved to the prefs. */
  setElementRate(rate: number): void {
    this.setNativeRate(rate);
    for (const el of this.els) el.playbackRate = rate;
  }

  /** Voice-chat ducking: a factor on the track's level, never saved. */
  setDuck(factor: number): void {
    this.duck = factor;
    this.applyGains();
  }

  duckLevel(): number {
    return this.duck;
  }

  private playRate(): number {
    return this.routed({ type: 'drives' }) ? 1 : this.rate();
  }

  private syncQueue(): void {
    this._queue.set([...this.mq.tracks]);
    this._queueIndex.set(this.mq.index);
    this._shuffle.set(this.mq.shuffle);
    this._repeat.set(this.mq.repeat);
  }

  private leaveMusic(): void {
    this._musicMode.set(false);
    this.mq.clear();
    this.syncQueue();
    this.applyGains();
  }

  private audioOf(t: MusicTrackRequest): AudioRequest {
    return { mediaId: t.mediaId, itemId: t.itemId, title: t.title, artist: t.artists, album: t.albumTitle, coverUrl: t.coverUrl };
  }

  /** Swaps to the preloaded element when it holds `t`, else opens it. */
  private async goTo(t: MusicTrackRequest): Promise<void> {
    if (this.nativeOn) {
      await this.nativeAudio!.skipTo({ index: this.mq.index });
      return this.nativeAudio!.play();
    }
    if (this.pre?.req === t) this.swapToPreloaded(this.pre);
    else await this.startMusic(t);
  }

  private async startMusic(req: MusicTrackRequest, autoplay = true, startAt = 0): Promise<void> {
    const generation = ++this.generation;
    await this.release();
    this._pitch.set(0);
    this._musicMode.set(true);
    this._track.set(this.audioOf(req));
    this._loading.set(true);
    this._position.set(startAt);
    this._duration.set(req.durationSeconds ?? 0);
    this._chapters.set([]);
    this._bookmarks.set([]);
    try {
      if (this.network.isOnline()) await this.sync.flush();
      if (autoplay && this.bindCast().isConnected()) return await this.startCast(req, generation);
      if (this.nativeAudio) return await this.startNative(autoplay, startAt);
      const local = await this.localParts(req.itemId);
      const opened = !local || this.network.isOnline()
        ? await this.streaming.getItemPlaybackInfo(req.itemId, this.deviceProfile.getProfile(), { startAt }).catch((e) => {
            if (!local) throw e;
            return null;
          })
        : null;
      if (generation !== this.generation) {
        if (opened?.sessionId) void this.streaming.stopSession(opened.sessionId).catch(() => undefined);
        return;
      }
      const info = local
        ? ({ ...opened, mediaFileId: local.mediaFileId, playMethod: 'DirectPlay', durationSeconds: local.book.durationSeconds || opened?.durationSeconds } as PlaybackInfoResponse)
        : opened!;
      this.info = info;
      this.sessionId = info.sessionId;
      this.parts = local ? local.parts : this.partsOf(info);
      this._duration.set(info.durationSeconds ?? req.durationSeconds ?? 0);
      this.setupMediaSession(this._track()!);
      await this.load(startAt, autoplay);
      void this.refreshStems();
    } catch {
      if (generation === this.generation) await this.close();
    } finally {
      if (generation === this.generation) {
        this.markStarting(autoplay);
        this._loading.set(false);
      }
    }
  }

  /** The Cast service, with its receiver signals followed from the first music track on. */
  private bindCast(): CastService {
    if (this.cast) return this.cast;
    const cast = (this.cast = this.injector.get(CastService));
    runInInjectionContext(this.injector, () => {
      effect(() => {
        const time = cast.currentTime();
        if (this.casting) this._position.set(time);
      });
      effect(() => {
        const paused = cast.isPaused();
        if (this.casting) this.onPlayState(!paused);
      });
      effect(() => {
        if (cast.ended() && this.casting) void this.onMusicEnded();
      });
      effect(() => {
        if (!cast.isConnected() && this.casting) void this.close();
      });
    });
    return cast;
  }

  private async startCast(req: MusicTrackRequest, generation: number): Promise<void> {
    await this.nativeAudio?.stop().catch(() => undefined);
    const info = await this.injector.get(CastPlayerService).castTrack(req);
    if (generation !== this.generation) return;
    if (!info) return void (await this.close());
    this.info = info;
    this.sessionId = info.sessionId;
    this.casting = true;
    this._duration.set(info.durationSeconds ?? req.durationSeconds ?? 0);
    this.setupMediaSession(this._track()!);
    this.onPlayState(true);
    this._stemMode.set('original');
    void this.refreshStems();
  }

  /** On Cast the receiver plays one file: a stem mode loads that stem (the guide, else the instrumental) at the position, `original` the track again. */
  private async switchCastStem(): Promise<void> {
    const req = this.mq.current;
    const file = this.castStemFile;
    if (!req || file === null) return;
    const mode = this._stemMode();
    const kind = mode === 'original' ? null : mode === 'guide' && 'guide' in this.castStemTypes ? 'guide' : 'instrumental';
    if (kind === this.castKind) return;
    const generation = this.generation;
    const position = this._position();
    const autoplay = this._playing();
    const cast = this.injector.get(CastPlayerService);
    const current = () => generation === this.generation;
    if (kind) {
      if (!(await cast.castStem(req, file, kind, this.castStemTypes[kind] ?? 'audio/ogg', position, autoplay, current))) {
        return void (current() && this.onStemsFailed());
      }
    } else {
      const info = await cast.castTrack(req, autoplay, position, current);
      if (!info) return void (current() && this.onStemsFailed());
      if (this.sessionId) void this.streaming.stopSession(this.sessionId).catch(() => undefined);
      this.info = info;
      this.sessionId = info.sessionId;
    }
    if (generation === this.generation) this.castKind = kind;
  }

  /** Loads the next track's stream on the standby element once the current one nears its end. */
  private preloadNext(): void {
    const next = this.mq.peekNext();
    if (!next || this.casting || this.routed({ type: 'drives' }) || this.preTried === next || this.info?.playMethod !== 'DirectPlay' || this._pitch() !== 0) return;
    this.preTried = next;
    const generation = this.generation;
    void this.localParts(next.itemId)
      .then(async (local) => {
        const opened = !local || this.network.isOnline()
          ? await this.streaming.getItemPlaybackInfo(next.itemId, this.deviceProfile.getProfile(), { startAt: 0 }).catch((e) => {
              if (!local) throw e;
              return null;
            })
          : null;
        const stale = generation !== this.generation || this.preTried !== next;
        if (stale || (!local && opened?.playMethod !== 'DirectPlay')) {
          if (opened?.sessionId) void this.streaming.stopSession(opened.sessionId).catch(() => undefined);
          return;
        }
        const info = local
          ? ({ ...opened, mediaFileId: local.mediaFileId, playMethod: 'DirectPlay', durationSeconds: local.book.durationSeconds || opened?.durationSeconds } as PlaybackInfoResponse)
          : opened!;
        const parts = local ? local.parts : this.partsOf(info);
        const url = parts[0].url;
        const standby = this.els[1 - this.current];
        standby.src = url;
        standby.load();
        this.applyGain(standby, next, url);
        this.pre = { req: next, info, url, parts };
      })
      .catch(() => undefined);
  }

  private dropPreload(): void {
    const pre = this.pre;
    this.pre = null;
    this.preTried = null;
    if (!pre) return;
    if (pre.info.sessionId) void this.streaming.stopSession(pre.info.sessionId).catch(() => undefined);
    const standby = this.els[1 - this.current];
    standby?.removeAttribute('src');
    standby?.load();
  }

  /** Ends the finished track's session and starts the buffered one on the standby element. */
  private swapToPreloaded(pre: NonNullable<typeof this.pre>): void {
    const old = this.els[this.current];
    const standby = this.els[1 - this.current];
    this._playing.set(false);
    this._position.set(this._duration());
    this.beat();
    if (this.sessionId) void this.streaming.stopSession(this.sessionId).catch(() => undefined);
    this.pre = null;
    this.preTried = null;
    this._pitch.set(0);
    this.current = 1 - this.current;
    this.info = pre.info;
    this.sessionId = pre.info.sessionId;
    this.parts = pre.parts;
    this.partIndex = 0;
    this._track.set(this.audioOf(pre.req));
    this._duration.set(pre.info.durationSeconds ?? pre.req.durationSeconds ?? 0);
    this._position.set(0);
    this.setupMediaSession(this._track()!);
    standby.playbackRate = this.playRate();
    standby.currentTime = 0;
    void standby.play().catch(() => undefined);
    old.pause();
    old.removeAttribute('src');
    this.dropStems();
    void this.refreshStems();
  }

  /** Moves on after a track ends: repeat one replays it, else the next track, else stops. */
  private async onMusicEnded(): Promise<void> {
    if (this.routed({ type: 'drives' })) {
      this._playing.set(false);
      this._position.set(this._duration());
      this._ended.set(true);
      this.beat();
      return;
    }
    const t = this.mq.next(true);
    if (t && this.mq.repeat === 'one' && !this.casting) {
      const el = this.el();
      if (el) {
        el.currentTime = 0;
        void el.play().catch(() => undefined);
      }
      return;
    }
    if (t) {
      this.syncQueue();
      return this.goTo(t);
    }
    this._playing.set(false);
    this._position.set(this._duration());
    this.beat();
  }

  private gainOf(req: MusicTrackRequest | null): number {
    return req ? replayGainFactor(this.replayGain(), this.preamp(), req, this.mq.singleAlbum) : 1;
  }

  /** Applies the ReplayGain of the playing track to its element and of the buffered one to the standby. */
  private applyGains(): void {
    if (this.nativeAudio) {
      this.pushGain();
      return this.pushNativeStems();
    }
    const cur = this.el();
    if (cur) this.applyGain(cur, this._musicMode() ? this.mq.current : null, cur.src);
    const standby = this.els[1 - this.current];
    if (standby && this.pre) this.applyGain(standby, this.pre.req, this.pre.url);
    this.applyStemGains();
  }

  private applyStemGains(): void {
    if (this.nativeAudio) return this.pushNativeStems();
    if (!this.stems?.loaded) return;
    this.stems.setGains(this.mix(), this.gainOf(this.mq.current) * this.duck * this.userLevel());
    void this.audioCtx?.resume().catch(() => undefined);
  }

  private mix() {
    return mixGains(this._stemMode(), this._vocalLevel(), !!this.stems?.loaded || this.nativeStemFile !== null);
  }

  private context(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    try {
      return (this.audioCtx ??= new AudioContext());
    } catch {
      return null;
    }
  }

  /** A GainNode when the stream is same-origin (a cross-origin element would go silent through Web Audio), else attenuation by `volume`. */
  private applyGain(el: HTMLAudioElement, req: MusicTrackRequest | null, url: string): void {
    const factor = this.gainOf(req) * this.duck * this.userLevel() * this.mix().main;
    let node = this.gainNodes.get(el);
    const ctx = !node && factor !== 1 && sameOrigin(url) ? this.context() : null;
    if (ctx) {
      try {
        node = ctx.createGain();
        ctx.createMediaElementSource(el).connect(node).connect(ctx.destination);
        this.gainNodes.set(el, node);
      } catch {
        node = undefined;
      }
    }
    if (node) {
      node.gain.value = factor;
      el.volume = 1;
      void this.audioCtx?.resume().catch(() => undefined);
    } else el.volume = Math.min(1, factor);
  }

  setStemMode(mode: StemMode): void {
    this._stemMode.set(mode);
    if (mode !== 'original') this._vocalLevel.set(mode === 'guide' ? GUIDE_VOCAL_LEVEL : 0);
    this.applyGains();
    if (this.casting) void this.switchCastStem();
  }

  /** Sets the vocal stem gain; from `original` it only stores the level for the next stem mode. */
  setVocalLevel(level: number): void {
    const v = Math.min(1, Math.max(0, level));
    this._vocalLevel.set(v);
    if (this._stemMode() !== 'original') this._stemMode.set(v === 0 ? 'instrumental' : 'guide');
    this.applyGains();
    if (this.casting) void this.switchCastStem();
  }

  /** Looks the playing track's stems up again, e.g. once a preparation finished. */
  async refreshStems(): Promise<void> {
    const run = ++this.stemsRun;
    const itemId = this._musicMode() && (this.casting || !this.stemsNative) && this._pitch() === 0 ? this._track()?.itemId : undefined;
    if (itemId === undefined) return this.dropStems();
    try {
      const api = this.injector.get(KaraokeApiService);
      const state = await api.itemState(itemId);
      if (run !== this.stemsRun) return;
      const ready = state.state === 'ready' && !!state.stems.instrumental && !!state.stems.vocals;
      if (!ready) return this.dropStems();
      if (this.casting) {
        this.castStemFile = state.fileId;
        this.castStemTypes = Object.fromEntries(Object.entries(state.stems).map(([k, v]) => [k, v.contentType]));
        return this._stemsAvailable.set(true);
      }
      if (this.serverConfig.isNative) await this.auth.ensureStreamToken(state.fileId);
      if (run !== this.stemsRun) return;
      if (this.nativeAudio) {
        this.nativeStemFile = state.fileId;
        this._stemsAvailable.set(true);
        return this.pushNativeStems();
      }
      this.stems ??= new StemMix(() => this.context(), (id, kind) => api.stemUrl(id, kind), () => this.onStemsReady(), () => this.onStemsFailed());
      if (!this.stems.load(state.fileId)) return this.dropStems();
      this._stemsAvailable.set(true);
    } catch {
      if (run === this.stemsRun) this.dropStems();
    }
  }

  /** Re-opens the playing track in another key (clamped to +-12 semitones) at the same position. */
  async setPitch(semitones: number): Promise<void> {
    const n = Math.min(12, Math.max(-12, Math.round(semitones)));
    const req = this.mq.current;
    if (n === this._pitch() || !req || !this._musicMode() || this.casting || this.nativeAudio) return;
    const generation = ++this.generation;
    const position = this._position();
    const autoplay = this._playing();
    const info = await this.streaming.getItemPlaybackInfo(req.itemId, this.deviceProfile.getProfile(), { startAt: position, pitchSemitones: n }).catch(() => null);
    if (!info || generation !== this.generation) {
      if (info?.sessionId) void this.streaming.stopSession(info.sessionId).catch(() => undefined);
      return;
    }
    this._pitch.set(n);
    this.dropPreload();
    this.dropStems();
    this._stemMode.set('original');
    this.applyGains();
    await this.swapInfo(info);
    await this.load(position, autoplay);
    if (n === 0) void this.refreshStems();
  }

  /** Makes `info` the open session, closing the previous one. */
  private async swapInfo(info: PlaybackInfoResponse): Promise<void> {
    await this.hls?.destroy().catch(() => undefined);
    this.hls = null;
    if (this.sessionId) void this.streaming.stopSession(this.sessionId).catch(() => undefined);
    this.info = info;
    this.sessionId = info.sessionId;
    this.parts = this.partsOf(info);
  }

  /** A Direct Play file the element reported it opens but cannot play: the track restarts as a transcode from the same position. */
  private async reopenTranscoded(): Promise<void> {
    const req = this.mq.current;
    if (!req || !this._musicMode() || this.casting || this.nativeAudio) return;
    const generation = ++this.generation;
    const position = this._position();
    const profile = { ...this.deviceProfile.getProfile(), rejectCopy: true };
    const info = await this.streaming.getItemPlaybackInfo(req.itemId, profile, { startAt: position }).catch(() => null);
    if (!info || generation !== this.generation || info.playMethod === 'DirectPlay') {
      if (info?.sessionId) void this.streaming.stopSession(info.sessionId).catch(() => undefined);
      return;
    }
    this.dropPreload();
    await this.swapInfo(info);
    await this.load(position, true);
  }

  private nativeStemFile: number | null = null;
  private castStemFile: number | null = null;
  /** Content type of each stem the receiver may load. */
  private castStemTypes: Partial<Record<StemKind, string>> = {};
  private castKind: StemKind | null = null;

  /** The native player loads the stems only in a stem mode, and mixes them with ReplayGain applied on its side. */
  private pushNativeStems(): void {
    const n = this.nativeAudio;
    if (!n) return;
    const file = this.nativeStemFile;
    if (file === null || this._stemMode() === 'original') return void n.clearStems().catch(() => undefined);
    const api = this.injector.get(KaraokeApiService);
    const g = this.mix();
    void n
      .setStems({ key: String(file), instrumentalUrl: api.stemUrl(file, 'instrumental'), vocalsUrl: api.stemUrl(file, 'vocals') })
      .then(() => n.setStemMix({ main: g.main, instrumental: g.instrumental, vocals: g.vocals }))
      .catch(() => undefined);
  }

  /** A stem that errors (evicted, token expired) hands the sound back to the original. */
  private onStemsFailed(): void {
    this.dropStems();
    this._stemMode.set('original');
    this.applyGains();
  }

  private onStemsReady(): void {
    this.applyGains();
    this.stems?.sync(this.el());
  }

  private dropStems(): void {
    this.stemsRun++;
    this._stemsAvailable.set(false);
    this.castStemFile = null;
    this.castKind = null;
    if (this.nativeStemFile !== null) {
      this.nativeStemFile = null;
      void this.nativeAudio?.clearStems().catch(() => undefined);
    }
    if (!this.stems) return;
    this.stems.clear();
    this.applyGains();
  }

  toggle(): void {
    if (this.routed({ type: 'toggle' })) return;
    if (this.nativeOn) return void (this._playing() ? this.nativeAudio!.pause() : this.nativeAudio!.play());
    if (this.casting) return this.cast!.togglePlayPause();
    const el = this.el();
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  pause(): void {
    if (this.nativeOn) return void this.nativeAudio!.pause();
    if (this.casting) return this.cast!.pause();
    this.el()?.pause();
  }

  /** Seeks on the item timeline, switching part when the position lies in another one. */
  async seek(position: number): Promise<void> {
    const target = Math.min(Math.max(0, position), this._duration());
    if (this._musicMode() && this.routed({ type: 'seek', at: target })) return;
    return this.seekLocal(target);
  }

  /** The seek itself, never routed to a party. */
  async seekLocal(target: number): Promise<void> {
    this._ended.set(false);
    if (this.casting) {
      this._position.set(target);
      this.cast!.seek(target);
      return this.beat();
    }
    if (this.nativeOn) {
      this._position.set(target);
      if (this._musicMode()) await this.nativeAudio!.seek({ position: target });
      else {
        const at = locate(this.parts, target);
        this.partIndex = at.index;
        await this.nativeAudio!.seek({ position: at.local, index: at.index });
      }
      return this.beat();
    }
    const { index, local } = locate(this.parts, target);
    this._position.set(target);
    const el = this.el();
    if (el && index === this.partIndex) {
      this.resumeSeek = false;
      el.currentTime = local;
    } else await this.load(target, !(el?.paused ?? true));
    this.beat();
  }

  skip(seconds: number): void {
    void this.seek(this._position() + seconds);
  }

  /** Without chapters it steps back like the skip button: it never rewinds a book to its start. */
  previousChapter(): void {
    if (!this._chapters().length) return this.skip(-this.skipBack());
    void this.seek(previousChapterStart(this._chapters(), this._position()));
  }

  nextChapter(): void {
    if (!this._chapters().length) return this.skip(this.skipForward());
    const next = nextChapterStart(this._chapters(), this._position());
    if (next !== null) void this.seek(next);
  }

  setRate(rate: number): void {
    this.updatePrefs({ rate });
    this.setNativeRate(rate);
    for (const el of this.els) el.playbackRate = rate;
    this.updatePositionState();
  }

  setSkips(skipBack: number, skipForward: number): void {
    this.updatePrefs({ skipBack, skipForward });
  }

  /** Pauses after `minutes`, or at the end of the chapter playing now; null clears it. */
  setSleep(timer: { minutes: number } | 'chapter' | null): void {
    clearInterval(this.sleepTimer);
    if (timer === null) {
      this._sleep.set(null);
      return;
    }
    if (timer === 'chapter') {
      const i = this.chapterIndex();
      const end = i >= 0 ? this._chapters()[i].end : this._duration();
      this._sleep.set({ kind: 'chapter', end });
      return;
    }
    const endsAt = Date.now() + timer.minutes * 60_000;
    this._sleep.set({ kind: 'duration', endsAt, minutes: timer.minutes });
    this._sleepLeft.set(timer.minutes * 60);
    this.sleepTimer = setInterval(() => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      this._sleepLeft.set(left);
      if (left === 0) this.fireSleep();
    }, 1000);
  }

  addBookmark(): void {
    const track = this._track();
    if (!track) return;
    const position = Math.floor(this._position());
    const list = [...this._bookmarks().filter((b) => b.position !== position), { position, createdAt: Date.now() }];
    this.saveBookmarks(track.itemId, list.sort((a, b) => a.position - b.position));
  }

  removeBookmark(b: AudioBookmark): void {
    const track = this._track();
    if (track) this.saveBookmarks(track.itemId, this._bookmarks().filter((x) => x.position !== b.position));
  }

  expand(): void {
    this._expanded.set(this._track() !== null);
  }

  collapse(): void {
    this._expanded.set(false);
  }

  /** Saves the position, ends the session and drops the player. */
  async close(): Promise<void> {
    this.generation++;
    this.level = 1;
    this.muted = false;
    if (this.casting) this.cast?.stop();
    await this.release();
    void this.nativeAudio?.stop().catch(() => undefined);
    this.leaveMusic();
    this._track.set(null);
    this._expanded.set(false);
    this._loading.set(false);
    this.markStarting(false);
    this._position.set(0);
    this._duration.set(0);
    this._chapters.set([]);
    this.setSleep(null);
    this.clearMediaSession();
  }

  private el(): HTMLAudioElement | null {
    return this.els[this.current] ?? null;
  }

  private ensureElements(): void {
    if (this.els.length) return;
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) {
      el.preload = 'auto';
      el.preservesPitch = true;
      const mine = (fn: () => void) => () => {
        if (this.el() === el) fn();
      };
      el.addEventListener('timeupdate', mine(() => this.onTime(el)));
      el.addEventListener('play', mine(() => this.onPlayState(true)));
      el.addEventListener('pause', mine(() => this.onPlayState(false)));
      el.addEventListener('ended', mine(() => void this.onEnded()));
      el.addEventListener('error', mine(() => this.onError()));
      el.addEventListener('waiting', mine(() => this._buffering.set(true)));
      for (const e of ['play', 'pause', 'playing', 'waiting', 'seeked', 'ratechange', 'timeupdate'] as const) {
        el.addEventListener(e, mine(() => this.stems?.sync(el)));
      }
      for (const e of ['playing', 'canplay', 'pause', 'emptied'] as const) el.addEventListener(e, mine(() => this._buffering.set(false)));
    }
  }

  /** The downloaded audio of an item as local part URLs, or null when it is not (fully) on the device. */
  private async localParts(itemId: number) {
    const task = this.downloads.tasks().find((t) => t.book?.family === 'audio' && t.book.itemId === itemId && t.status === 'ready');
    const book = task?.book;
    if (!task || !book) return null;
    const parts: PlayPart[] = [];
    for (const f of book.files) {
      const url = await this.store.fileUrl(book, f.key);
      if (!url) return null;
      parts.push({ url, offset: f.offsetS, duration: f.durationS });
    }
    return { book, parts, mediaFileId: task.mediaFileId };
  }

  private partsOf(info: PlaybackInfoResponse): PlayPart[] {
    if (info.playMethod === 'DirectPlay' && info.parts?.length) {
      return info.parts.map((p) => ({
        url: this.streaming.buildPlayUrl({ playMethod: 'DirectPlay', playUrl: p.playUrl }, { sid: info.sessionId }),
        offset: p.offsetS,
        duration: p.durationS,
      }));
    }
    const url = this.streaming.buildPlayUrl(info, { sid: info.sessionId });
    return [{ url, offset: 0, duration: info.durationSeconds ?? 0 }];
  }

  private chaptersOf(info: PlaybackInfoResponse): TimelineChapter[] {
    if (info.chapters?.length) {
      return info.chapters.map((c) => ({ title: c.title ?? null, start: c.startSeconds, end: c.endSeconds }));
    }
    return info.parts && info.parts.length > 1
      ? chaptersFromParts(info.parts.map((p) => ({ offset: p.offsetS, duration: p.durationS })))
      : [];
  }

  /** Puts the part holding `position` on the active element and starts it there. */
  private async load(position: number, autoplay: boolean): Promise<void> {
    const { index, local } = locate(this.parts, position);
    if (this.nativeAudio) return this.loadNativeParts(index, local, autoplay);
    this.ensureElements();
    this.partIndex = index;
    this.preloaded = -1;
    const el = this.els[this.current];
    const part = this.parts[index];
    el.playbackRate = this._musicMode() ? this.playRate() : this.rate();
    this.applyGain(el, this._musicMode() ? this.mq.current : null, part.url);
    if (this.info?.playMethod === 'DirectPlay') {
      el.src = part.url;
      this.startAt(el, local, autoplay);
    } else if (this.native(el)) {
      el.src = part.url;
      this.startAt(el, position, autoplay);
    } else {
      await this.attachHls(el, part.url, position);
      if (autoplay) void el.play().catch(() => undefined);
    }
  }

  /** False once the user seeks: the resume point still waiting for metadata must not undo it. */
  private resumeSeek = true;

  private native(el: HTMLAudioElement): boolean {
    return el.canPlayType('application/vnd.apple.mpegurl') !== '';
  }

  private startAt(el: HTMLAudioElement, seconds: number, autoplay: boolean): void {
    this.resumeSeek = true;
    el.addEventListener(
      'loadedmetadata',
      () => {
        if (seconds > 0 && this.resumeSeek) el.currentTime = seconds;
        if (autoplay) void el.play().catch(() => undefined);
      },
      { once: true },
    );
  }

  private async attachHls(el: HTMLAudioElement, url: string, position: number): Promise<void> {
    const shaka = (await import('shaka-player')).default;
    shaka.polyfill.installAll();
    const player = new shaka.Player();
    await player.attach(el);
    this.hls = player;
    await player.load(url, position > 0 ? position : undefined);
  }

  private onTime(el: HTMLAudioElement): void {
    const part = this.parts[this.partIndex];
    if (!part) return;
    const position = part.offset + el.currentTime;
    this._position.set(position);
    const sleep = this._sleep();
    if (sleep?.kind === 'chapter' && position >= sleep.end - 0.3) this.fireSleep();
    const next = this.parts[this.partIndex + 1];
    if (next && this.preloaded !== this.partIndex + 1 && part.duration - el.currentTime < PRELOAD_S) {
      this.preloaded = this.partIndex + 1;
      const standby = this.els[1 - this.current];
      standby.src = next.url;
      standby.load();
    }
    if (this._musicMode() && !this.pre && this._duration() - position < PRELOAD_S) this.preloadNext();
    const now = Date.now();
    if (now - this.lastPositionState > POSITION_STATE_MS) {
      this.lastPositionState = now;
      this.updatePositionState();
    }
  }

  private onPlayState(playing: boolean): void {
    this._playing.set(playing);
    if (playing) this.markStarting(false);
    // Paused too while online: a silent owner is parked, and a parked owner is never told of a takeover.
    clearInterval(this.beatTimer);
    this.beatTimer = setInterval(() => {
      if (playing || this.network.isOnline()) this.beat();
    }, BEAT_MS);
    this.beat();
    if (!this.nativeAudio && 'mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  /** Next part on the standby element (already buffered when preloaded), else the next volume of the queue. */
  private async onEnded(): Promise<void> {
    if (this._musicMode()) return this.onMusicEnded();
    const next = this.parts[this.partIndex + 1];
    if (next) {
      const el = this.els[this.current];
      const standby = this.els[1 - this.current];
      this.current = 1 - this.current;
      this.partIndex++;
      this.preloaded = -1;
      standby.playbackRate = this.rate();
      if (!standby.src.endsWith(next.url)) standby.src = next.url;
      standby.currentTime = 0;
      void standby.play().catch(() => undefined);
      el.removeAttribute('src');
      return;
    }
    this._playing.set(false);
    this._position.set(this._duration());
    this.beat();
    await this.playNextVolume();
  }

  private async playNextVolume(): Promise<void> {
    const track = this._track();
    if (!track || !this.bookQueue.autoplay() || this.bookQueue.current()?.mediaId !== track.mediaId) return;
    const next = this.bookQueue.advance();
    if (!next) return;
    try {
      const req = await this.audiobookRequest(next.mediaId);
      if (req) await this.play(req);
    } catch {
      // The failed request already toasted.
    }
  }

  private userLevel(): number {
    return this.muted ? 0 : this.level;
  }

  /** Web elements only: a native or cast output keeps its own volume. */
  private volumeReport() {
    const supportsVolume = !this.nativeOn && !this.casting;
    return { supportsVolume, ...(supportsVolume && { volume: this.level, muted: this.muted }) };
  }

  private async queueOf(q: WireQueue): Promise<{ tracks: MusicTrackRequest[]; index: number }> {
    const aligned = alignTrackRows(q.itemIds, await this.music.trackRequests(q.itemIds));
    return { tracks: aligned.map((a) => a.row), index: Math.max(0, aligned.findIndex((a) => a.wireIndex >= q.index)) };
  }

  /** Opens a remote queue where the sender left it; the order is the sender's, never reshuffled. */
  private async startQueue(q: WireQueue, shuffle: boolean, repeat: Repeat, startAt: number, autoplay: boolean): Promise<void> {
    if (this.blockedByParty()) return;
    const generation = ++this.generation;
    const { tracks, index } = await this.queueOf(q);
    if (generation !== this.generation || !tracks.length || this.blockedByParty()) return;
    this.mq.adopt(tracks, index, shuffle);
    this.mq.repeat = repeat;
    this.syncQueue();
    await this.startMusic(this.mq.current!, autoplay, startAt);
  }

  /** `load` of an audio family: an album queue, or the audio edition of a book. */
  private async loadFromRemote(cmd: RemoteCommand): Promise<void> {
    const startAt = cmd.positionSeconds ?? 0;
    const autoplay = cmd.paused !== true;
    if (cmd.kind === 'album' && cmd.queue?.itemIds.length) {
      return this.startQueue(cmd.queue, cmd.shuffle ?? false, cmd.repeat ?? 'off', startAt, autoplay);
    }
    if (!cmd.itemId || this.blockedByParty()) return;
    const generation = ++this.generation;
    const req = cmd.kind === 'album' ? null : cmd.mediaId ? await this.audiobookRequest(cmd.mediaId, cmd.itemId) : null;
    if (generation !== this.generation) return;
    if (req) return this.play(req, { startAt, paused: !autoplay });
    return this.startQueue({ itemIds: [cmd.itemId], index: 0 }, false, 'off', startAt, autoplay);
  }

  /** "Play here" on a session of another device: its queue and its position now. */
  private async resumeSession(s: AccountSession, positionSeconds: number): Promise<void> {
    const paused = s.state === 'paused' || s.state === 'parked';
    if (s.item.kind === 'album') {
      const q = s.queue ?? { itemIds: [s.item.id], index: 0, shuffle: false, repeat: 'off' as const };
      await this.startQueue(q, q.shuffle, q.repeat, positionSeconds, !paused);
    } else {
      const req = await this.audiobookRequest(s.item.mediaId, s.item.id);
      if (req) await this.play(req, { startAt: positionSeconds, paused });
    }
    // A paused load reports no play state: its first beat is what claims the session.
    if (paused && this._track()) this.onPlayState(false);
  }

  /** Commands of a controller for the playback this device holds; a `load` goes through the loader. */
  private async applyRemote(cmd: RemoteCommand): Promise<void> {
    if (!this._track() || this.blockedByParty()) return;
    const music = this._musicMode();
    switch (cmd.action) {
      case 'play':
        this.resume();
        break;
      case 'pause':
        this.pause();
        break;
      case 'playpause':
        this.toggle();
        break;
      case 'seek':
        if (cmd.positionSeconds !== undefined) await this.seek(cmd.positionSeconds);
        break;
      case 'next':
        this.next();
        break;
      case 'prev':
        this.previous(false);
        break;
      case 'stop':
        this.remote.markApplied(cmd.cmdId);
        await this.close();
        return;
      case 'volume':
        if (cmd.level !== undefined) this.setLevel(cmd.level, this.muted);
        break;
      case 'mute':
        this.setLevel(this.level, cmd.muted ?? !this.muted);
        break;
      case 'shuffle':
        if (music) this.setShuffle(cmd.shuffle ?? !this.mq.shuffle);
        break;
      case 'repeat':
        if (music) this.setRepeat(cmd.repeat ?? this.mq.repeat);
        break;
      case 'queue':
        if (music && cmd.queue) await this.replaceQueue(cmd.queue, cmd.shuffle ?? this.mq.shuffle);
        break;
      default:
        return;
    }
    this.remote.markApplied(cmd.cmdId);
    this.beat();
  }

  private setLevel(level: number, muted: boolean): void {
    this.level = Math.min(1, Math.max(0, level));
    this.muted = muted;
    this.applyGains();
  }

  /** Swaps the queue under the running track; another current track starts it. */
  private async replaceQueue(q: WireQueue, shuffle: boolean): Promise<void> {
    const { tracks, index } = await this.queueOf(q);
    if (!tracks.length) return;
    if (tracks.length === this.mq.tracks.length && tracks.every((t, i) => t.itemId === this.mq.tracks[i].itemId)) {
      this.playQueueAt(index);
      return;
    }
    if (tracks[index].itemId !== this.mq.current?.itemId) {
      this.mq.adopt(tracks, index, shuffle);
      this.syncQueue();
      return this.startMusic(this.mq.current!);
    }
    this.mq.adopt(tracks, index, shuffle);
    this.dropPreload();
    this.syncQueue();
    this.pushQueue();
  }

  /** The audio edition of a book as a request, or null when it has none. */
  private async audiobookRequest(mediaId: number, itemId?: number): Promise<AudioRequest | null> {
    const media = await this.mediaService.getOne(mediaId);
    const book = asBookMedia(media)?.book;
    const edition = book?.editions.find((e) => e.family === 'audio' && e.hasFile && e.itemId != null && (!itemId || e.itemId === itemId));
    if (!book || !edition?.itemId) return null;
    return {
      mediaId,
      itemId: edition.itemId,
      title: media.title,
      artist: book.authors.map((a) => a.name).join(', '),
      coverUrl: edition.coverUrl ?? media.posterUrl,
    };
  }

  private onError(): void {
    this._playing.set(false);
    this._loading.set(false);
    this.markStarting(false);
    if (this.info?.playMethod === 'DirectPlay' && this._musicMode()) void this.reopenTranscoded();
  }

  /** A play or pause key: a party hears it as a toggle, and only when it changes something. */
  private setPlaying(want: boolean): void {
    if (want === this._playing()) return;
    if (this.routed({ type: 'toggle' })) return;
    if (want) this.resume();
    else this.pause();
  }

  private fireSleep(): void {
    this.setSleep(null);
    this.pause();
  }

  private body() {
    const track = this._track();
    const info = this.info;
    if (!track || !info) return null;
    return {
      mediaId: track.mediaId,
      payload: {
        positionSeconds: this._position(),
        durationSeconds: this._duration(),
        mediaFileId: info.mediaFileId,
        itemId: track.itemId,
        sessionId: this.sessionId,
        handoff: this.sessionSync.handoffFor(this.sessionId),
        state: this._playing() ? ('playing' as const) : ('paused' as const),
        ...this.volumeReport(),
      } satisfies BeatBody,
    } as { mediaId: number; payload: BeatBody };
  }

  /** A beat the server does not take is kept, and replayed once it answers. */
  private beat(final = false): void {
    const b = this.body();
    if (!b) return;
    const { positionSeconds, durationSeconds, mediaFileId, itemId } = b.payload;
    // The closing beat belongs to the ended session: a queue adopted for the next one must not ride on it.
    const queue = final ? null : this.queueToSend();
    if (queue) b.payload.queue = queue;
    const ack = this.remote.lastAppliedCmdId();
    if (ack) b.payload.lastCmdId = ack;
    const saved = { mediaId: b.mediaId, mediaFileId, itemId, positionSeconds, durationSeconds };
    const music = this._musicMode();
    if (!this.network.isOnline()) return music ? undefined : void this.sync.queue(saved);
    this.streaming
      .updatePlaybackState(b.mediaId, b.payload)
      .then((r) => {
        if (r?.sessionLost) this.sessionId = undefined;
        if (r?.superseded && b.payload.sessionId) void this.sessionSync.handleSuperseded(b.payload.sessionId);
        if (!music) this.sync.record(saved);
      })
      .catch(() => {
        if (queue) this.queueSent = null;
        if (!music) this.sync.queue(saved);
      });
  }

  /** What the last beat carried: the queue goes out on the first beat of a session and when it changes. */
  private queueSent: string | null = null;

  /** The queue as the wire carries it: at most 500 ids around the current track, index rebased. */
  private wireQueue(): NonNullable<BeatBody['queue']> | null {
    const ids = this.mq.tracks.map((t) => t.itemId);
    if (!ids.length) return null;
    const start = Math.max(0, Math.min(this.mq.index - WIRE_QUEUE_MAX / 2, ids.length - WIRE_QUEUE_MAX));
    return {
      itemIds: ids.slice(start, start + WIRE_QUEUE_MAX),
      index: this.mq.index - start,
      shuffle: this.mq.shuffle,
      repeat: this.mq.repeat,
    };
  }

  private queueToSend(): BeatBody['queue'] | null {
    if (!this._musicMode()) return null;
    const value = this.wireQueue();
    if (!value) return null;
    const key = `${this.sessionId}:${JSON.stringify(value)}`;
    if (key === this.queueSent) return null;
    this.queueSent = key;
    return value;
  }

  private beatOnExit(): void {
    const b = this.body();
    if (!b) return;
    const { url, init } = this.streaming.positionRequest(b.mediaId);
    void fetch(url, { ...init, body: JSON.stringify({ ...b.payload, sessionId: undefined }) }).catch(() => undefined);
  }

  /** Saves the position and tears the current item down. */
  private async release(): Promise<void> {
    clearInterval(this.beatTimer);
    const el = this.el();
    if ((el || this.casting || this.nativeOn) && this.info) {
      this._playing.set(false);
      this.beat(true);
    }
    this.dropPreload();
    this.dropStems();
    await this.hls?.destroy().catch(() => undefined);
    this.hls = null;
    for (const e of this.els) {
      e.pause();
      e.removeAttribute('src');
      e.load();
    }
    // The native player ends the sessions of the tracks it resolved itself.
    if (this.sessionId && !(this.nativeOn && this._musicMode())) void this.streaming.stopSession(this.sessionId).catch(() => undefined);
    this.sessionId = undefined;
    this.info = null;
    this.nativeOn = false;
    this.nativeReady = false;
    this.parts = [];
    this.partIndex = 0;
    this.current = 0;
    this.casting = false;
    this._playing.set(false);
    this._ended.set(false);
    this._buffering.set(false);
  }

  private onMediaKey(e: KeyboardEvent): void {
    if (!this.active()) return;
    const action = mediaKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === 'toggle') this.toggle();
    else if (action === 'play') this.setPlaying(true);
    else if (action === 'pause') this.setPlaying(false);
    else if (action === 'stop') void this.close();
    else if (this._musicMode()) action === 'forward' ? this.next() : this.previous();
    else this.skip(action === 'forward' ? this.skipForward() : -this.skipBack());
  }

  private setupMediaSession(req: AudioRequest): void {
    if (this.nativeAudio || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const art = req.coverUrl ? new URL(this.serverConfig.resolveUrl(req.coverUrl), document.baseURI).href : null;
    ms.metadata = new MediaMetadata({
      title: req.title,
      artist: req.artist ?? '',
      album: req.album ?? '',
      artwork: art ? [{ src: art }] : [],
    });
    const on = (a: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {
        // An action this browser does not know.
      }
    };
    on('play', () => this.setPlaying(true));
    on('pause', () => this.setPlaying(false));
    on('stop', () => void this.close());
    on('seekbackward', (d) => this.skip(-(d.seekOffset ?? this.skipBack())));
    on('seekforward', (d) => this.skip(d.seekOffset ?? this.skipForward()));
    on('seekto', (d) => void this.seek(d.seekTime ?? 0));
    on('previoustrack', () => this.previous());
    on('nexttrack', () => this.next());
  }

  private updatePositionState(): void {
    if (this.nativeAudio || !('mediaSession' in navigator) || !this._duration()) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: this._duration(),
        position: Math.min(this._position(), this._duration()),
        playbackRate: this.rate(),
      });
    } catch {
      // A position beyond the declared duration.
    }
  }

  private clearMediaSession(): void {
    if (this.nativeAudio || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }

  // ---- native player (Capacitor) ----

  private async attachNative(): Promise<void> {
    const n = this.nativeAudio!;
    void n.addListener('state', (e) => this.onNativeState(e));
    void n.addListener('position', (e) => this.onNativePosition(e));
    void n.addListener('track', (e) => this.onNativeTrack(e));
    void n.addListener('queue', (e) => this.onNativeQueue(e));
    void n.addListener('command', (e) => this.onNativeCommand(e));
    void n.addListener('stems', (e) => {
      if (e.state === 'failed') this.onStemsFailed();
    });
    void n.addListener('error', () => this.onError());
    void n.addListener('refresh', () => void this.auth.refreshAccessToken());
    await this.deviceProfile.whenNativeProbed();
    await n.configure({ deviceProfile: JSON.stringify(this.deviceProfile.getProfile()) });
    this.pushGain();
    await n.attach();
  }

  private pushGain(): void {
    void this.nativeAudio?.setGain({ mode: this.replayGain(), preamp: this.preamp(), duck: this.duck }).catch(() => undefined);
  }

  private setNativeRate(rate: number): void {
    if (!this.nativeOn) return;
    this.nativeRate = rate;
    void this.nativeAudio!.setRate({ rate });
  }

  private pushQueue(): void {
    if (!this.nativeOn || !this._musicMode()) return;
    const { tracks, index } = { tracks: this.mq.tracks, index: this.mq.index };
    this.pushed = this.pushed.then(async () => this.nativeAudio?.updateQueue({ tracks: await this.nativeTracks(tracks), index })).catch(() => undefined);
  }

  /** Pushes land in the order they were made, whatever the time each one took to resolve its files. */
  private pushed: Promise<unknown> = Promise.resolve();

  /** The queue for the native player: a downloaded track carries the file to play, the others are resolved by native. */
  private async nativeTracks(tracks: readonly MusicTrackRequest[]): Promise<NativeAudioTrackRequest[]> {
    return Promise.all(
      tracks.map(async (t) => {
        const local = await this.localParts(t.itemId);
        return local ? { ...t, localUrl: local.parts[0].url } : { ...t };
      }),
    );
  }

  /** Controls outside the app go to the party while one drives the audio. */
  private syncRouting(): void {
    if (!this.nativeAudio) return;
    const routed = this.routed({ type: 'drives' });
    if (routed === this.routedSent) return;
    this.routedSent = routed;
    void this.nativeAudio.setRouted({ routed });
  }

  private async startNative(autoplay: boolean, startAt = 0): Promise<void> {
    const n = this.nativeAudio!;
    this.nativeOn = true;
    this.nativeIndex = this.mq.index;
    this.nativeEnded = false;
    this.nativeRate = this.playRate();
    this.syncRouting();
    this.pushGain();
    await n.setRate({ rate: this.nativeRate });
    await n.setRepeat({ mode: this.mq.repeat });
    await n.setQueue({ tracks: await this.nativeTracks(this.mq.tracks), index: this.mq.index, autoplay, ...(startAt > 0 && { startAt }) });
    void this.refreshStems();
  }

  /** The parts of an audiobook, played back to back from `local` seconds into part `index`. */
  private async loadNativeParts(index: number, local: number, autoplay: boolean): Promise<void> {
    const req = this._track()!;
    this.partIndex = index;
    this.nativeOn = true;
    this.nativeEnded = false;
    this.nativeRate = this.rate();
    await this.nativeAudio!.loadParts({
      parts: this.parts.map((p) => ({ url: p.url })),
      index,
      startAt: local,
      autoplay,
      rate: this.rate(),
      title: req.title,
      artist: req.artist,
      album: req.album,
      artworkUrl: req.coverUrl ? new URL(this.serverConfig.resolveUrl(req.coverUrl), document.baseURI).href : null,
      book: this.info
        ? {
            mediaId: req.mediaId,
            itemId: req.itemId,
            mediaFileId: this.info.mediaFileId,
            sessionId: this.sessionId,
            durationSeconds: this._duration(),
            offsets: this.parts.map((p) => p.offset),
          }
        : undefined,
    });
  }

  private onNativeState(s: NativeAudioState): void {
    if (!this.nativeOn) return;
    this.nativeReady = s.ready;
    this._buffering.set(s.buffering);
    if (s.playing !== this._playing()) this.onPlayState(s.playing);
    if (!s.ended) this.nativeEnded = false;
    else if (!this.nativeEnded) {
      this.nativeEnded = true;
      this.onNativeEnded();
    }
  }

  /** The queue or the last part ran out: a party's track waits for the server, a book moves to its next volume. */
  private onNativeEnded(): void {
    if (this._musicMode() && this.routed({ type: 'drives' })) this._ended.set(true);
    this._playing.set(false);
    this._position.set(this._duration());
    this.beat();
    if (!this._musicMode()) void this.playNextVolume();
  }

  private onNativePosition(p: NativeAudioPosition): void {
    if (!this.nativeOn) return;
    let position = p.position;
    if (this._musicMode()) {
      if (p.index !== this.mq.index) return;
      if (p.duration > 0 && p.duration !== this._duration()) this._duration.set(p.duration);
    } else {
      const part = this.parts[p.index];
      if (!part) return;
      this.partIndex = p.index;
      position += part.offset;
    }
    this._position.set(position);
    const sleep = this._sleep();
    if (sleep?.kind === 'chapter' && position >= sleep.end - 0.3) this.fireSleep();
  }

  private onNativeTrack(e: NativeAudioTrack): void {
    if (!this.nativeOn) return;
    if (!this._musicMode()) {
      if (this.parts[e.index]) this.partIndex = e.index;
      return;
    }
    if (e.index !== this.mq.index) {
      if (!this.mq.playAt(e.index)) return;
      this.syncQueue();
    }
    const cur = this.mq.current;
    if (!cur) return;
    if (e.index !== this.nativeIndex || this._track()?.itemId !== cur.itemId) {
      this.nativeIndex = e.index;
      const playing = this._playing();
      this._playing.set(false);
      this._position.set(this._duration());
      this.beat();
      this._playing.set(playing);
      this._track.set(this.audioOf(cur));
      this._duration.set(cur.durationSeconds ?? 0);
      this._position.set(0);
      this._ended.set(false);
      this.info = null;
      this.sessionId = undefined;
      this.dropStems();
      void this.refreshStems();
    }
    if (e.mediaFileId && e.itemId === cur.itemId && !this.info) {
      this.info = { playMethod: 'DirectPlay', mediaFileId: e.mediaFileId, sessionId: e.sessionId } as PlaybackInfoResponse;
      this.sessionId = e.sessionId;
    }
  }

  /** A queue the native side built (Android Auto): the web queue follows it. */
  private onNativeQueue(e: NativeAudioQueue): void {
    if (!e.tracks.length || this.blockedByParty()) return;
    this.nativeOn = true;
    this.nativeEnded = false;
    this.nativeIndex = -1;
    this.parts = [];
    this.info = null;
    this._musicMode.set(true);
    this.mq.set(e.tracks, e.index, false);
    this.mq.repeat = this._repeat();
    this.syncQueue();
    this._track.set(this.audioOf(this.mq.current!));
    this._chapters.set([]);
    this._bookmarks.set([]);
  }

  private onNativeCommand(c: NativeAudioCommand): void {
    if (c.command === 'play') this.setPlaying(true);
    else if (c.command === 'pause') this.setPlaying(false);
    else if (c.command === 'next') this.next();
    else if (c.command === 'previous') this.previous();
    else void this.seek(c.value);
  }

  private readPrefs(): Prefs {
    const base: Prefs = { rate: 1, skipBack: 15, skipForward: 30, replayGain: 'track', preamp: 0 };
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const saved = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
      return {
        rate: SPEEDS.includes(saved.rate ?? 0) ? saved.rate! : base.rate,
        skipBack: SKIP_STEPS.includes(saved.skipBack ?? 0) ? saved.skipBack! : base.skipBack,
        skipForward: SKIP_STEPS.includes(saved.skipForward ?? 0) ? saved.skipForward! : base.skipForward,
        replayGain: REPLAY_GAINS.includes(saved.replayGain!) ? saved.replayGain! : base.replayGain,
        preamp: PREAMP_STEPS.includes(saved.preamp ?? NaN) ? saved.preamp! : base.preamp,
      };
    } catch {
      return base;
    }
  }

  private updatePrefs(patch: Partial<Prefs>): void {
    this._prefs.update((p) => ({ ...p, ...patch }));
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this._prefs()));
    } catch {
      // Storage unavailable: the choice lasts for the session.
    }
  }

  private bookmarksKey(): string {
    return `${BOOKMARKS_KEY}::${this.storage.suffix()}`;
  }

  private readBookmarks(itemId: number): AudioBookmark[] {
    try {
      const all = JSON.parse(localStorage.getItem(this.bookmarksKey()) ?? '{}') as Record<string, AudioBookmark[]>;
      return all[itemId] ?? [];
    } catch {
      return [];
    }
  }

  private saveBookmarks(itemId: number, list: AudioBookmark[]): void {
    this._bookmarks.set(list);
    if (!this.storage.canPersist()) return;
    try {
      const all = JSON.parse(localStorage.getItem(this.bookmarksKey()) ?? '{}') as Record<string, AudioBookmark[]>;
      if (list.length) all[itemId] = list;
      else delete all[itemId];
      localStorage.setItem(this.bookmarksKey(), JSON.stringify(all));
    } catch {
      // Storage unavailable: the bookmarks last for the session.
    }
  }
}

/** Platforms whose native player mixes stems (karaoke spec rule 30). */
const NATIVE_STEMS = ['android', 'ios'];

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, document.baseURI).origin === location.origin;
  } catch {
    return false;
  }
}
