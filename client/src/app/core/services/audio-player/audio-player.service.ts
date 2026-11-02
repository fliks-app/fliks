import { Injectable, computed, inject, signal } from '@angular/core';
import { ServerConfigService } from '../server-config.service';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { MediaService } from '../api/media.service';
import { StreamingApiService, type PlaybackInfoResponse } from '../api/streaming-api.service';
import { PlaybackQueueService } from '../playback-queue.service';
import { StorageScopeService } from '../storage-scope.service';
import { asBookMedia } from '../../../features/media-detail/book/book-media';
import { mediaKeyAction } from '../../../features/player/player-keymap';
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
  /** Seconds on the item timeline; absent resumes at the saved position. */
  startAt?: number;
}

export interface AudioBookmark {
  position: number;
  createdAt: number;
}

/** Sleep timer: a wall-clock deadline, or the end of the chapter playing when it was set. */
export type SleepTimer = { kind: 'duration'; endsAt: number; minutes: number } | { kind: 'chapter'; end: number };

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
}

const BEAT_MS = 15_000;
const PRELOAD_S = 20;
const POSITION_STATE_MS = 1000;
const PREFS_KEY = 'fliks.audio.prefs';
const BOOKMARKS_KEY = 'fliks.audio.bookmarks';

/** The one audio player of the app: an `<audio>` pair driven as a single timeline across the parts of an item, outliving every route. */
@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  private readonly streaming = inject(StreamingApiService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly mediaService = inject(MediaService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly storage = inject(StorageScopeService);

  private readonly _track = signal<AudioRequest | null>(null);
  private readonly _playing = signal(false);
  private readonly _loading = signal(false);
  private readonly _position = signal(0);
  private readonly _duration = signal(0);
  private readonly _chapters = signal<TimelineChapter[]>([]);
  private readonly _sleep = signal<SleepTimer | null>(null);
  private readonly _sleepLeft = signal(0);
  private readonly _prefs = signal<Prefs>(this.readPrefs());
  private readonly _bookmarks = signal<AudioBookmark[]>([]);
  private readonly _expanded = signal(false);

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

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => this.beatOnExit());
    window.addEventListener('keydown', (e) => this.onMediaKey(e));
  }

  /** Starts the item, or toggles it when it is the one loaded. */
  async play(req: AudioRequest): Promise<void> {
    if (this._track()?.itemId === req.itemId && this.info) {
      this.toggle();
      return;
    }
    const generation = ++this.generation;
    await this.release();
    this._track.set(req);
    this._loading.set(true);
    this._position.set(req.startAt ?? 0);
    this._duration.set(0);
    this._chapters.set([]);
    this._bookmarks.set(this.readBookmarks(req.itemId));
    this.queue.syncTo(req.mediaId);
    try {
      const info = await this.streaming.getItemPlaybackInfo(req.itemId, this.deviceProfile.getProfile(), {
        startAt: req.startAt,
      });
      if (generation !== this.generation) return;
      this.info = info;
      this.sessionId = info.sessionId;
      this.parts = this.partsOf(info);
      this._duration.set(info.durationSeconds ?? this.parts.reduce((s, p) => s + p.duration, 0));
      this._chapters.set(this.chaptersOf(info));
      this.setupMediaSession(req);
      const start = req.startAt ?? info.startAtSeconds ?? 0;
      await this.load(start, true);
    } catch {
      if (generation === this.generation) await this.close();
    } finally {
      if (generation === this.generation) this._loading.set(false);
    }
  }

  toggle(): void {
    const el = this.el();
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  pause(): void {
    this.el()?.pause();
  }

  /** Seeks on the item timeline, switching part when the position lies in another one. */
  async seek(position: number): Promise<void> {
    const target = Math.min(Math.max(0, position), this._duration());
    const { index, local } = locate(this.parts, target);
    this._position.set(target);
    const el = this.el();
    if (el && index === this.partIndex) el.currentTime = local;
    else await this.load(target, !(el?.paused ?? true));
    this.beat();
  }

  skip(seconds: number): void {
    void this.seek(this._position() + seconds);
  }

  previousChapter(): void {
    void this.seek(previousChapterStart(this._chapters(), this._position()));
  }

  nextChapter(): void {
    const next = nextChapterStart(this._chapters(), this._position());
    if (next !== null) void this.seek(next);
  }

  setRate(rate: number): void {
    this.updatePrefs({ rate });
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
    await this.release();
    this._track.set(null);
    this._expanded.set(false);
    this._loading.set(false);
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
    }
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
    this.ensureElements();
    const { index, local } = locate(this.parts, position);
    this.partIndex = index;
    this.preloaded = -1;
    const el = this.els[this.current];
    const part = this.parts[index];
    el.playbackRate = this.rate();
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

  private native(el: HTMLAudioElement): boolean {
    return el.canPlayType('application/vnd.apple.mpegurl') !== '';
  }

  private startAt(el: HTMLAudioElement, seconds: number, autoplay: boolean): void {
    el.addEventListener(
      'loadedmetadata',
      () => {
        if (seconds > 0) el.currentTime = seconds;
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
    const now = Date.now();
    if (now - this.lastPositionState > POSITION_STATE_MS) {
      this.lastPositionState = now;
      this.updatePositionState();
    }
  }

  private onPlayState(playing: boolean): void {
    this._playing.set(playing);
    clearInterval(this.beatTimer);
    if (playing) this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
    this.beat();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  /** Next part on the standby element (already buffered when preloaded), else the next volume of the queue. */
  private async onEnded(): Promise<void> {
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
    if (!track || !this.queue.autoplay() || this.queue.current()?.mediaId !== track.mediaId) return;
    const next = this.queue.advance();
    if (!next) return;
    try {
      const media = await this.mediaService.getOne(next.mediaId);
      const book = asBookMedia(media)?.book;
      const edition = book?.editions.find((e) => e.family === 'audio' && e.hasFile && e.itemId != null);
      if (!book || !edition?.itemId) return;
      await this.play({
        mediaId: next.mediaId,
        itemId: edition.itemId,
        title: media.title,
        artist: book.authors.map((a) => a.name).join(', '),
        coverUrl: edition.coverUrl ?? media.posterUrl,
      });
    } catch {
      // The failed request already toasted.
    }
  }

  private onError(): void {
    this._playing.set(false);
    this._loading.set(false);
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
        state: this._playing() ? ('playing' as const) : ('paused' as const),
      },
    };
  }

  private beat(): void {
    const b = this.body();
    if (!b) return;
    this.streaming
      .updatePlaybackState(b.mediaId, b.payload)
      .then((r) => {
        if (r?.sessionLost) this.sessionId = undefined;
      })
      .catch(() => undefined);
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
    if (el && this.info) {
      this._playing.set(false);
      this.beat();
    }
    await this.hls?.destroy().catch(() => undefined);
    this.hls = null;
    for (const e of this.els) {
      e.pause();
      e.removeAttribute('src');
      e.load();
    }
    if (this.sessionId) void this.streaming.stopSession(this.sessionId).catch(() => undefined);
    this.sessionId = undefined;
    this.info = null;
    this.parts = [];
    this.partIndex = 0;
    this.current = 0;
    this._playing.set(false);
  }

  private onMediaKey(e: KeyboardEvent): void {
    if (!this.active()) return;
    const action = mediaKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === 'toggle') this.toggle();
    else if (action === 'play') void this.el()?.play();
    else if (action === 'pause') this.pause();
    else if (action === 'stop') void this.close();
    else this.skip(action === 'forward' ? this.skipForward() : -this.skipBack());
  }

  private setupMediaSession(req: AudioRequest): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const art = req.coverUrl ? new URL(this.serverConfig.resolveUrl(req.coverUrl), document.baseURI).href : null;
    ms.metadata = new MediaMetadata({
      title: req.title,
      artist: req.artist ?? '',
      artwork: art ? [{ src: art }] : [],
    });
    const on = (a: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {
        // An action this browser does not know.
      }
    };
    on('play', () => void this.el()?.play());
    on('pause', () => this.pause());
    on('stop', () => void this.close());
    on('seekbackward', (d) => this.skip(-(d.seekOffset ?? this.skipBack())));
    on('seekforward', (d) => this.skip(d.seekOffset ?? this.skipForward()));
    on('seekto', (d) => void this.seek(d.seekTime ?? 0));
    on('previoustrack', () => this.previousChapter());
    on('nexttrack', () => this.nextChapter());
  }

  private updatePositionState(): void {
    if (!('mediaSession' in navigator) || !this._duration()) return;
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
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }

  private readPrefs(): Prefs {
    const base: Prefs = { rate: 1, skipBack: 15, skipForward: 30 };
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const saved = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
      return {
        rate: SPEEDS.includes(saved.rate ?? 0) ? saved.rate! : base.rate,
        skipBack: SKIP_STEPS.includes(saved.skipBack ?? 0) ? saved.skipBack! : base.skipBack,
        skipForward: SKIP_STEPS.includes(saved.skipForward ?? 0) ? saved.skipForward! : base.skipForward,
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
