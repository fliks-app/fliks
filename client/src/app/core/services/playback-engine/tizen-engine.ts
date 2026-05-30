import {
  AbstractPlaybackEngine,
  AudioTrack,
  EngineStats,
  PlaybackEngine,
  PlaybackState,
} from './playback-engine';
import { SubtitleOverlay } from './subtitle-overlay.util';

/**
 * Samsung Tizen AVPlay backend.
 *
 * `webapis.avplay` is a process-wide singleton bound to the
 * `<object id="fliks-avplay" type="application/avplayer">` declared at
 * HTML parse time (creating it dynamically silently fails). The video
 * surface renders on a hardware plane BEHIND the WebView; DOM overlays
 * paint on top of transparent CSS regions driven by
 * `html.native-player-active`. HEVC / AV1 / Dolby decoding and HLS ABR
 * are handled natively — Shaka chokes on Tizen 6.5 MSE quirks.
 */

declare const webapis: {
  avplay: {
    open(url: string): void;
    close(): void;
    prepare(): void;
    prepareAsync(success: () => void, error: (e: unknown) => void): void;
    play(): void;
    pause(): void;
    resume?(): void;
    stop(): void;
    seekTo(ms: number, success?: () => void, error?: (e: unknown) => void): void;
    getCurrentTime(): number;
    getDuration(): number;
    getState(): 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED';
    setDisplayRect(x: number, y: number, width: number, height: number): void;
    setDisplayMethod(method: string): void;
    setListener(listener: {
      onbufferingstart?: () => void;
      onbufferingprogress?: (percent: number) => void;
      onbufferingcomplete?: () => void;
      oncurrentplaytime?: (currentTimeMs: number) => void;
      onerror?: (err: string) => void;
      onstreamcompleted?: () => void;
      onevent?: (name: string, data: string) => void;
      onsubtitlechange?: (duration: number, text: string, type: number, attributeCount: number, attributes: unknown) => void;
      ondrmevent?: (drmEvent: string, drmData: unknown) => void;
    }): void;
    getTotalTrackInfo(): Array<{ type: 'AUDIO' | 'TEXT' | 'VIDEO'; index: number; extra_info: string }>;
    setSelectTrack(type: 'AUDIO' | 'TEXT' | 'VIDEO', index: number): void;
    setStreamingProperty(name: string, value: string): void;
    setExternalSubtitlePath(path: string): void;
    setSilentSubtitle(silent: boolean): void;
  };
};

const AVPLAY_OBJECT_ID = 'fliks-avplay';

export const isTizenAvplayAvailable = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { webapis?: unknown }).webapis !== 'undefined' &&
    typeof (window as unknown as { webapis?: { avplay?: unknown } }).webapis?.avplay === 'object'
  );
};

export class TizenEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  /** Most recently `init()`'d instance. The shared AVPlay surface and
   *  native listener fan out to whoever holds this slot. */
  private static activeEngine: TizenEngine | null = null;
  /** `setListener` is append-only on Tizen 6.5 — calling it more than
   *  ~20 times exits the WAS process. Install once per process and
   *  dispatch through `activeEngine`. */
  private static listenerInstalled = false;

  private avObject: HTMLObjectElement | null = null;
  private _lastLoadedUrl: string | null = null;
  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = false;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _audioTracks: AudioTrack[] = [];
  /** AVPlay exposes no `getCurrentAudioTrack()` — track it ourselves
   *  so the dropdown reflects the active language. */
  private _currentAudioIndex = 0;
  private firstFrameEmitted = false;
  private orientationHandler: (() => void) | null = null;
  private _seekInFlight = false;
  private _pendingSeek: number | null = null;

  /** One-shot guard for the optimistic-recovery branch in
   *  {@link handleError}. AVPlay can't surface HTTP status, so the
   *  first network-shaped error during stable playback is treated as a
   *  possible session-expired event and emits `sessionExpired` instead
   *  of a fatal `error`. Subsequent errors fall through normally. Reset
   *  on every {@link load} so a fresh playback starts with a fresh
   *  budget. */
  private recoveryAttempted = false;

  /** DOM-rendered subtitle overlay shared with the webOS engine. AVPlay's
   *  `setExternalSubtitlePath` only accepts local file paths, not HTTPS,
   *  so we parse VTT ourselves and paint cues into a positioned div. */
  private readonly subtitles = new SubtitleOverlay();

  // ── Lifecycle ───────────────────────────────────────────────────────

  async init(_container: HTMLElement): Promise<void> {
    if (!isTizenAvplayAvailable()) {
      throw new Error('Tizen AVPlay not available (webapis.avplay missing)');
    }
    const obj = document.getElementById(AVPLAY_OBJECT_ID) as HTMLObjectElement | null;
    if (!obj) {
      throw new Error('Tizen AVPlay surface missing — index.html should define <object id="' + AVPLAY_OBJECT_ID + '">');
    }
    obj.style.display = 'block';
    this.avObject = obj;
    TizenEngine.activeEngine = this;
    this.applyDisplayRect();
    this.orientationHandler = () => this.applyDisplayRect();
    window.addEventListener('resize', this.orientationHandler);
  }

  async destroy(): Promise<void> {
    if (this.orientationHandler) {
      window.removeEventListener('resize', this.orientationHandler);
      this.orientationHandler = null;
    }
    // Only stop the shared AVPlay surface if this engine still owns it — a
    // stale engine tearing down after a newer one took over must not stop
    // the newer engine's playback.
    if (TizenEngine.activeEngine === this) {
      try {
        const s = webapis.avplay.getState();
        if (s !== 'NONE' && s !== 'IDLE') webapis.avplay.stop();
      } catch { /* ok */ }
      if (this.avObject) this.avObject.style.display = 'none';
      TizenEngine.activeEngine = null;
    }
    this.avObject = null;
    this.subtitles.destroy();
    this.clearHandlers();
  }

  private applyDisplayRect() {
    if (!this.avObject) return;
    try {
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
    } catch { /* invalid in NONE — re-applied post-prepare */ }
  }

  // ── Loading ─────────────────────────────────────────────────────────

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    _headers?: Record<string, string>,
  ): Promise<void> {
    this._lastLoadedUrl = url;
    this.firstFrameEmitted = false;
    this.recoveryAttempted = false;
    this._currentTime = 0;
    this._duration = 0;

    const safeUrl = resolveAvtestUrl(url);

    try {
      const s = webapis.avplay.getState();
      if (s !== 'NONE' && s !== 'IDLE') {
        try { webapis.avplay.stop(); } catch { /* ok */ }
      }
    } catch { /* ok */ }
    webapis.avplay.open(safeUrl);

    // Cap AVPlay's ABR band — segments below 2 Mbps are useless on a
    // TV display and the constant rung-switching they trigger drains
    // the HW decoder. STARTBITRATE pins the opening rung high.
    try {
      webapis.avplay.setStreamingProperty(
        'ADAPTIVE_INFO',
        'BITRATES=2000000~30000000|STARTBITRATE=8000000|SKIPBITRATE=2000000',
      );
    } catch { /* old firmware — default ABR is fine */ }

    // Seeding the resume position in IDLE pre-prepare lets AVPlay
    // request the right segment first instead of the "play from 0 →
    // seek to X" round-trip (which on slow backends races with FFmpeg
    // segment generation and 404s).
    if (startTime !== undefined && startTime > 0) {
      try { webapis.avplay.seekTo(Math.round(startTime * 1000)); } catch { /* ok */ }
    }

    TizenEngine.ensureGlobalListener();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { webapis.avplay.stop(); } catch { /* ok */ }
        document.documentElement.classList.remove('native-player-active');
        const msg = 'AVPlay prepareAsync timeout (30s)';
        this.emit('error', { code: -1, message: msg, errorKey: 'player.playback_error' });
        reject(new Error(msg));
      }, 30000);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      try {
        webapis.avplay.prepareAsync(
          () => done(() => {
            try {
              this._duration = (webapis.avplay.getDuration() ?? 0) / 1000;
            } catch { this._duration = 0; }
            try { this.populateAudioTracks(); } catch { /* tracks not ready */ }
            try { this.applyDisplayRect(); } catch { /* ok */ }
            if (!this._paused) {
              try { webapis.avplay.play(); } catch (e) {
                this.emit('error', { code: -1, message: 'AVPlay play (post-prepare) failed: ' + String(e), errorKey: 'player.playback_error' });
              }
              this.emit('stateChanged', { state: 'playing' });
            } else {
              this.emit('stateChanged', { state: 'paused' });
            }
            if (startTime && startTime > 0) this._currentTime = startTime;
            resolve();
          }),
          (err) => done(() => {
            try { webapis.avplay.stop(); } catch { /* ok */ }
            document.documentElement.classList.remove('native-player-active');
            this.emit('error', { code: -1, message: 'AVPlay prepare failed: ' + String(err), errorKey: 'player.playback_error' });
            reject(new Error('AVPlay prepare failed: ' + String(err)));
          }),
        );
      } catch (e) {
        done(() => {
          try { webapis.avplay.stop(); } catch { /* ok */ }
          document.documentElement.classList.remove('native-player-active');
          const msg = 'AVPlay prepareAsync threw: ' + (e instanceof Error ? e.message : String(e));
          this.emit('error', { code: -1, message: msg, errorKey: 'player.playback_error' });
          reject(new Error(msg));
        });
      }
    });
  }

  async unload(): Promise<void> {
    try {
      const s = webapis.avplay.getState();
      if (s !== 'NONE' && s !== 'IDLE') webapis.avplay.stop();
    } catch { /* ok */ }
  }

  private static ensureGlobalListener(): void {
    if (TizenEngine.listenerInstalled) return;
    TizenEngine.listenerInstalled = true;
    webapis.avplay.setListener({
      onbufferingstart: () => TizenEngine.activeEngine?.handleBufferingStart(),
      onbufferingcomplete: () => TizenEngine.activeEngine?.handleBufferingComplete(),
      oncurrentplaytime: (ms) => TizenEngine.activeEngine?.handleCurrentPlayTime(ms),
      onerror: (err) => TizenEngine.activeEngine?.handleError(err),
      onstreamcompleted: () => TizenEngine.activeEngine?.handleStreamCompleted(),
      onevent: () => { /* opaque AVPlay events */ },
    });
  }

  private handleBufferingStart(): void {
    this.emit('stateChanged', { state: 'buffering' });
  }
  private handleBufferingComplete(): void {
    if (!this._paused) this.emit('stateChanged', { state: 'playing' });
  }
  private handleCurrentPlayTime(ms: number): void {
    this._currentTime = ms / 1000;
    this._buffered = this._currentTime;
    this.emit('timeUpdate', {
      position: this._currentTime,
      duration: this._duration,
      buffered: this._buffered,
    });
    this.subtitles.updateAt(this._currentTime);
    if (!this.firstFrameEmitted && ms > 0) {
      this.firstFrameEmitted = true;
      this.emit('firstFrame', undefined);
    }
  }
  private handleError(err: unknown): void {
    // Seek failures go through `runSeek`'s per-call error path (which
    // reloads). The global onerror fires for them too — suppress the
    // duplicate so the player UI doesn't surface a "Playback error"
    // on top of an in-flight recovery.
    if (this._seekInFlight) return;
    const msg = String(err);
    if (msg.includes('SEEK_FAILED')) return;

    // AVPlay swallows the HTTP status of the failed segment fetch — we
    // can't tell a 410 (session expired) from a 500 (ffmpeg crash) from
    // here. Heuristic: if playback was healthy (firstFrame fired, no
    // pending seek) and the connection errored mid-stream, optimistically
    // ask the player for one cheap recovery attempt before surfacing the
    // fatal error. If recovery succeeds the engine reloads transparently;
    // if it fails the next error after `recoveryAttempted` falls through
    // to the regular error path.
    if (
      this.firstFrameEmitted &&
      !this.recoveryAttempted &&
      /CONNECTION|HTTP|NETWORK|PLAYER_ERROR_INVALID_URI/i.test(msg)
    ) {
      this.recoveryAttempted = true;
      this.emit('sessionExpired', undefined);
      return;
    }
    this.emit('error', { code: -1, message: msg, errorKey: 'player.playback_error' });
    this.emit('stateChanged', { state: 'error' });
  }
  private handleStreamCompleted(): void {
    this.emit('stateChanged', { state: 'ended' });
    this.emit('ended', undefined);
  }

  // ── Playback ────────────────────────────────────────────────────────

  async play(): Promise<void> {
    this._paused = false;
    try {
      const s = webapis.avplay.getState();
      if (s === 'PAUSED' && typeof webapis.avplay.resume === 'function') {
        webapis.avplay.resume();
      } else if (s === 'READY') {
        webapis.avplay.play();
      }
      // NONE / IDLE: post-prepare success checks `_paused` and starts
      // playback once AVPlay reaches READY. PLAYING: nothing to do.
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay play failed: ' + String(e), errorKey: 'player.playback_error' });
    }
    this.emit('stateChanged', { state: 'playing' });
  }

  async pause(): Promise<void> {
    this._paused = true;
    try {
      if (webapis.avplay.getState() === 'PLAYING') webapis.avplay.pause();
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay pause failed: ' + String(e), errorKey: 'player.playback_error' });
    }
    this.emit('stateChanged', { state: 'paused' });
  }

  async seek(position: number): Promise<void> {
    if (!isFinite(position) || isNaN(position)) return;
    if (this._seekInFlight) {
      this._pendingSeek = position;
      return;
    }
    return this.runSeek(position);
  }

  private async runSeek(position: number): Promise<void> {
    this._seekInFlight = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('seek timeout'));
        }, 35000);
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        try {
          webapis.avplay.seekTo(
            Math.round(position * 1000),
            () => done(() => {
              this._currentTime = position;
              resolve();
            }),
            async (err) => {
              if (settled) return;
              clearTimeout(timer);
              settled = true;
              if (!this._lastLoadedUrl) {
                reject(new Error(`seek failed: ${err}`));
                return;
              }
              // Recover by reloading at the target. Clear the in-flight flag
              // and drop any seek queued during this failed one first, so the
              // reload's own seek isn't blocked and a now-stale pending seek
              // isn't replayed on top of the recovered position.
              this._seekInFlight = false;
              this._pendingSeek = null;
              try {
                await this.load(this._lastLoadedUrl, position);
                resolve();
              } catch (e) {
                reject(e);
              }
            },
          );
        } catch (e) {
          done(() => reject(e));
        }
      });
    } finally {
      this._seekInFlight = false;
      if (this._pendingSeek !== null) {
        const next = this._pendingSeek;
        this._pendingSeek = null;
        void this.runSeek(next);
      }
    }
  }

  // ── State getters ───────────────────────────────────────────────────

  get currentTime(): number {
    try {
      return webapis.avplay.getCurrentTime() / 1000;
    } catch {
      return this._currentTime;
    }
  }
  get duration(): number { return this._duration; }
  get paused(): boolean { return this._paused; }
  get buffered(): number { return this._buffered; }
  get playbackRate(): number { return this._playbackRate; }
  set playbackRate(_rate: number) {
    /* `setSpeed(rate)` exists on AVPlay but the controls UI doesn't expose rate on TV. */
  }
  get volume(): number { return this._volume; }
  set volume(v: number) {
    this._volume = v;
    /* AVPlay uses system volume; no per-stream knob. */
  }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    /* No web-level mute API on AVPlay; rely on TV remote / system. */
  }

  // ── Audio tracks ────────────────────────────────────────────────────

  private populateAudioTracks() {
    try {
      const all = webapis.avplay.getTotalTrackInfo() ?? [];
      const audioTracks = all.filter((t) => t.type === 'AUDIO');
      this._currentAudioIndex = audioTracks[0]?.index ?? 0;
      this._audioTracks = audioTracks.map((t) => {
        const meta = parseAvplayExtraInfo(t.extra_info);
        return {
          id: 'avplay-audio-' + t.index,
          language: meta.language ?? 'und',
          label: meta.label ?? meta.language ?? 'Track ' + t.index,
        } as AudioTrack;
      });
      if (this._audioTracks.length > 0) this.emitAudioTracks();
    } catch { /* getTotalTrackInfo throws pre-READY — retried via audioTracksChanged later */ }
  }

  /** Emit with `selected` flag so the picker highlights the active language. */
  private emitAudioTracks(): void {
    const tracks = this._audioTracks.map((t) => {
      const idx = Number(t.id.replace('avplay-audio-', ''));
      return { ...t, selected: idx === this._currentAudioIndex } as AudioTrack & {
        selected: boolean;
      };
    });
    this.emit('audioTracksChanged', { tracks });
  }

  getAudioTracks(): AudioTrack[] {
    return [...this._audioTracks];
  }

  async selectAudioTrack(id: string): Promise<void> {
    const m = /^avplay-audio-(\d+)$/.exec(id);
    if (!m) return;
    const index = Number(m[1]);
    try {
      webapis.avplay.setSelectTrack('AUDIO', index);
      this._currentAudioIndex = index;
      this.emitAudioTracks();
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay setSelectTrack audio failed: ' + String(e), errorKey: 'player.playback_error' });
    }
  }

  // ── Subtitles (DOM-rendered overlay) ────────────────────────────────

  async addTextTrack(url: string, language: string, label: string): Promise<unknown> {
    return { url, language, label };
  }

  selectTextTrack(track: unknown): void {
    if (!track || typeof track !== 'object') {
      this.subtitles.clear();
      return;
    }
    const url = (track as { url?: string }).url;
    if (url) void this.subtitles.show(url);
  }

  setTextVisibility(visible: boolean): void {
    this.subtitles.setVisible(visible);
  }

  /** Same preset enums Shaka consumes from `player-settings.service`. */
  setSubtitleStyle(style: {
    size?: string;
    color?: string;
    shadow?: string;
    background?: string;
    bottomMargin?: number;
  }): void {
    this.subtitles.setStyle(style);
  }

  // ── Quality — AVPlay handles ABR internally ────────────────────────

  getVariantTracks(): unknown[] { return []; }
  selectVariantTrack(_track: unknown, _clearBuffer?: boolean): void {
    /* AVPlay does its own ABR; manual pinning would need
       setStreamingProperty('AVAILABLE_BITRATE', '<min~max>'). */
  }
  configure(_config: unknown): void { /* Shaka-specific */ }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): EngineStats {
    return { droppedFrames: 0 };
  }
}

/**
 * `localStorage['fliks.avtest']` selects an alternate URL for AVPlay
 * compatibility testing — '1' / 'master' point at Apple reference
 * streams, 'fmp4ref' at a known-broken-on-Tizen sample, 'variant'
 * rewrites our master to its 1080p child playlist, 'encoded'
 * percent-encodes JWT dots in the token. Anything else passes through.
 */
function resolveAvtestUrl(url: string): string {
  const flag =
    typeof localStorage !== 'undefined' ? localStorage.getItem('fliks.avtest') : null;
  if (flag === '1') {
    return 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8';
  }
  if (flag === 'master') {
    return 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3.m3u8';
  }
  if (flag === 'fmp4ref') {
    return 'https://d2zihajmogu5jn.cloudfront.net/fmp4-muxed-no-playlist-codecs/index.m3u8';
  }
  if (flag === 'variant') {
    return url.replace(/\/master\.m3u8(\?|$)/, '/1080p/index.m3u8$1');
  }
  if (flag === 'encoded') {
    return url.replace(
      /([?&]token=)([^&#]+)/,
      (_m, prefix, tok) => prefix + tok.replace(/\./g, '%2E'),
    );
  }
  return url;
}

interface AvplayTrackMeta {
  language?: string;
  label?: string;
}

/**
 * `extra_info` is a JSON-ish blob whose shape depends on the firmware.
 * 2020+ Q-series TVs return stringified JSON; older builds return a
 * flat ":"/"|"-separated string.
 */
function parseAvplayExtraInfo(raw: string): AvplayTrackMeta {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      language: typeof j['language'] === 'string' ? (j['language'] as string) : undefined,
      label:
        typeof j['label'] === 'string'
          ? (j['label'] as string)
          : typeof j['language'] === 'string'
            ? (j['language'] as string)
            : undefined,
    };
  } catch {
    const parts = raw.split(/[:|]/);
    return {
      language: parts.find((p) => /^[a-z]{2,3}$/i.test(p)),
      label: raw,
    };
  }
}
