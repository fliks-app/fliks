import {
  AbstractPlaybackEngine,
  AudioTrack,
  EngineStats,
  PlaybackEngine,
  PlaybackState,
} from './playback-engine';
import {
  SUBTITLE_SIZE_MAP,
  SUBTITLE_COLOR_MAP,
  SUBTITLE_SHADOW_MAP,
  SUBTITLE_BG_MAP,
} from '../player-settings.service';

/**
 * Samsung Tizen AVPlay backend.
 *
 * Tizen's web runtime exposes a native media player through `webapis.avplay`
 * — a singleton bound to a single `<object type="application/avplayer">`
 * element. It decodes HEVC / H.264 / AV1 / Dolby in hardware, handles HLS
 * adaptive bitrate internally (no MSE / SourceBuffer plumbing), and is the
 * only path that survives the codec mismatch quirks that Shaka hits on
 * Tizen 6.5 (e.g. EAC3 audio: `MediaSource.isTypeSupported` returns true,
 * but `addSourceBuffer('audio/mp4; codecs="ec-3"')` throws —
 * `[Player] Init error: 3015 …` and the WebView stays black).
 *
 * The video surface lives BEHIND the WebView (same model as
 * `NativeEngine` on Android): the AVPlay object renders to a hardware
 * layer; everything in the Angular template paints on top with
 * transparent backgrounds (driven by `html.native-player-active`).
 *
 * Subtitle and ABR controls intentionally minimal in V1 — they go
 * through AVPlay's `setSelectTrack` / `setStreamingProperty` APIs once
 * the basic playback loop is proven.
 */

// AVPlay is a globally-registered Tizen WebAPI. Declared loosely here so
// the build doesn't depend on `@types/tizen-tv-webapis` (not on npm at
// time of writing). The runtime check below guards every call.
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

interface VttCue {
  start: number;
  end: number;
  text: string;
}

export class TizenEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  private avObject: HTMLObjectElement | null = null;
  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _audioTracks: AudioTrack[] = [];
  /** Last AVPlay audio track index we asked for (or were defaulted to).
   *  AVPlay doesn't expose a `getCurrentAudioTrack()`; track it ourselves
   *  so the dropdown reflects the active language. */
  private _currentAudioIndex = 0;
  private firstFrameEmitted = false;
  private orientationHandler: (() => void) | null = null;
  // ── Subtitle overlay (DOM-rendered) ──
  // AVPlay's `setExternalSubtitlePath` only accepts local file paths,
  // not HTTPS URLs, and we ship no privilege to write to /tmp on the
  // TV. We parse the VTT ourselves and render text in a positioned div,
  // syncing on `oncurrentplaytime`.
  private subtitleEl: HTMLDivElement | null = null;
  private parsedCues: VttCue[] = [];
  private subtitleVisible = false;
  private lastCueText = '';

  // ── Lifecycle ───────────────────────────────────────────────────────

  async init(_container: HTMLElement): Promise<void> {
    if (!isTizenAvplayAvailable()) {
      throw new Error('Tizen AVPlay not available (webapis.avplay missing)');
    }

    // The AVPlay object lives in index.html (parsed before Angular boot)
    // because Samsung's runtime instantiates the native player plugin at
    // HTML-parse time and only binds `webapis.avplay` to objects it saw
    // then. Creating it dynamically here silently fails: `prepareAsync`
    // rejects every URL with `InvalidAccessError`. Promote the static
    // element to fullscreen + z-0 so it sits behind the WebView surface;
    // teardown reverts to the parked geometry.
    const obj = document.getElementById(AVPLAY_OBJECT_ID) as HTMLObjectElement | null;
    if (!obj) {
      throw new Error('Tizen AVPlay surface missing — index.html should define <object id="' + AVPLAY_OBJECT_ID + '">');
    }
    // Reveal the surface. The element is `display:none` in index.html so
    // the unsupported-plugin placeholder doesn't cover the home page on
    // non-Tizen browsers and stays out of the layout flow on TV until a
    // playback engine actually exists.
    obj.style.display = 'block';
    this.avObject = obj;

    // Resize the AVPlay surface when the window itself resizes — Tizen
    // overscan trims ~4% on each axis, and the player object dimensions
    // must be in screen pixels (setDisplayRect ignores CSS percentages).
    this.applyDisplayRect();
    this.orientationHandler = () => this.applyDisplayRect();
    window.addEventListener('resize', this.orientationHandler);
  }

  async destroy(): Promise<void> {
    try {
      const state = webapis.avplay.getState();
      if (state !== 'NONE' && state !== 'IDLE') webapis.avplay.stop();
      webapis.avplay.close();
    } catch {
      /* AVPlay throws if already closed — fine. */
    }
    if (this.orientationHandler) {
      window.removeEventListener('resize', this.orientationHandler);
      this.orientationHandler = null;
    }
    // Hide the surface again so the unsupported-plugin chrome doesn't
    // surface on the home page / other routes once playback ends. The
    // element itself stays in DOM (TizenEngine re-uses it next time).
    if (this.avObject) this.avObject.style.display = 'none';
    this.avObject = null;
    // Tear down subtitle overlay so the next engine starts fresh.
    if (this.subtitleEl?.parentElement) {
      this.subtitleEl.parentElement.removeChild(this.subtitleEl);
    }
    this.subtitleEl = null;
    this.parsedCues = [];
    this.subtitleVisible = false;
    this.lastCueText = '';
    this.clearHandlers();
  }

  private applyDisplayRect() {
    if (!this.avObject) return;
    // AVPlay HW plane → fullscreen, video letter-boxed inside. The
    // WebView is composited *above* the plane on Tizen 6.5 (verified:
    // `<object>` z-index doesn't affect stacking, and shrinking the
    // element doesn't reveal the plane edges either), so the DOM
    // overlays (controls, loading spinner, error dialog) are visible on
    // top of the video as long as they actually have non-zero
    // dimensions — see `player.ts` `.player-container` which uses
    // explicit `top/right/bottom/left:0` instead of the `inset:0`
    // shorthand (Chrome 87+; Tizen 6.5 = Chromium 85 ignores it and
    // collapses the element to 0×0).
    try {
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
    } catch {
      /* setDisplayRect throws when AVPlay state is NONE — first call
         before open() falls into this branch and is recovered
         post-prepare from the success callback. */
    }
  }

  // ── Loading ─────────────────────────────────────────────────────────

  /** Last URL passed to `load()` — kept so the seek-failure recovery
   *  path can reload the stream at the user's target without going
   *  back through the player layer. */
  private _lastLoadedUrl: string | null = null;

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    this._lastLoadedUrl = url;
    this.firstFrameEmitted = false;
    this._currentTime = 0;
    this._duration = 0;

    // Close any in-flight session so open() doesn't INVALID_STATE.
    try {
      const s = webapis.avplay.getState();
      if (s !== 'NONE' && s !== 'IDLE') webapis.avplay.stop();
      webapis.avplay.close();
    } catch {
      /* OK */
    }

    // Diagnostic flag: `localStorage['fliks.avtest']` selects an
    // alternate URL to isolate failure modes —
    //   - '1' → Apple's reference single-variant HLS-TS (proven working)
    //   - 'master' → Apple's multi-variant master playlist (TS)
    //   - 'fmp4ref' → external reference single-variant fMP4 with audio
    //     muxed inline. Confirmed during issue #148 bisection that
    //     Tizen AVPlay rejects this layout outright — kept here for
    //     future re-tests against newer firmware.
    //   - 'variant' → our backend's 1080p variant (skipping master)
    // anything else → the requested URL.
    const flag =
      typeof localStorage !== 'undefined' ? localStorage.getItem('fliks.avtest') : null;
    let safeUrl: string;
    if (flag === '1') {
      safeUrl = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8';
    } else if (flag === 'master') {
      safeUrl = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3.m3u8';
    } else if (flag === 'fmp4ref') {
      safeUrl = 'https://d2zihajmogu5jn.cloudfront.net/fmp4-muxed-no-playlist-codecs/index.m3u8';
    } else if (flag === 'variant') {
      // Rewrite master.m3u8 → 1080p/index.m3u8 so AVPlay bypasses the
      // master parser entirely and consumes a flat single-rendition
      // playlist. Same auth (`?token=`) carries over.
      safeUrl = url.replace(/\/master\.m3u8(\?|$)/, '/1080p/index.m3u8$1');
    } else if (flag === 'encoded') {
      // Percent-encode the JWT dots in the query string. JWTs have two
      // literal `.` separators which some embedded URL parsers (incl.
      // older AVPlay builds) misread as path-extension boundaries,
      // confusing the HLS detector. The backend's URL decoder reads
      // back the original token.
      safeUrl = url.replace(
        /([?&]token=)([^&#]+)/,
        (_m, prefix, tok) => prefix + tok.replace(/\./g, '%2E'),
      );
    } else {
      safeUrl = url;
    }
    void headers;

    // Strict Samsung-sample order — every divergence we tried ends in
    // `InvalidAccessError`. The official SDC2016 VideoAVPlayer sample
    // calls `open → setListener → prepare → setDisplayRect`. Setting
    // the listener AFTER open() and the display rect AFTER prepare
    // appears to be a state-machine requirement on Tizen 6.5; setting
    // the display rect before prepare while still in NONE state seems
    // to leave AVPlay confused and the prepare error fires.
    // eslint-disable-next-line no-console
    console.log('[TizenEngine] open URL:', safeUrl);
    webapis.avplay.open(safeUrl);

    // Pin AVPlay's adaptive-bitrate behaviour for the CMAF / single-LAN
    // case (see `browser-device-profile.service.ts` for the `useCmaf`
    // rationale). CMAF segments are self-contained mp4s with their own
    // moov + HEVC config, so every ABR shift forces a decoder re-init
    // and a buffer drain — left untouched, AVPlay pings between 1080p
    // and 144p several times per second on a 4K LAN target. The
    // ADAPTIVE_INFO trio (Samsung-specific extension to AVPlay) caps
    // that:
    //   - STARTBITRATE: pin the initial rung high so the first
    //     segments are already top-quality;
    //   - BITRATES min~max: refuse rungs outside the band;
    //   - SKIPBITRATE: floor for emergency-downshift decisions.
    // The minimum (2 Mbps) cuts the 144p / 240p / 360p rungs from the
    // selection set entirely — they exist for true bandwidth-starved
    // clients (mobile data) and aren't useful on a TV.
    try {
      webapis.avplay.setStreamingProperty(
        'ADAPTIVE_INFO',
        'BITRATES=2000000~30000000|STARTBITRATE=8000000|SKIPBITRATE=2000000',
      );
    } catch {
      /* old firmware may not expose ADAPTIVE_INFO; default ABR is fine. */
    }

    // Set the START position BEFORE prepareAsync. Per Samsung docs,
    // `seekTo` while in IDLE state pins the start time so the first
    // segment AVPlay requests is already at the resume position. The
    // earlier post-prepare seek racked up a "play from 0 → seek to X"
    // sequence: AVPlay grabbed seg-0000 first, which made the backend
    // restart FFmpeg at segment 1; only then did the seek hit, by
    // which point FFmpeg was busy regenerating early segments and the
    // resume segment wasn't on disk yet → 404 → playback error.
    if (startTime && startTime > 0) {
      try {
        webapis.avplay.seekTo(Math.round(startTime * 1000));
      } catch {
        /* IDLE-state seek rejected on some firmware — the resume offset
           is also encoded in `?startAt=` on the master URL, so even
           without an IDLE seek the backend has already pre-warmed the
           right segment range. */
      }
    }

    webapis.avplay.setListener({
      onbufferingstart: () => this.emit('stateChanged', { state: 'buffering' }),
      onbufferingcomplete: () => {
        if (!this._paused) this.emit('stateChanged', { state: 'playing' });
      },
      oncurrentplaytime: (ms) => {
        this._currentTime = ms / 1000;
        this._buffered = this._currentTime;
        this.emit('timeUpdate', {
          position: this._currentTime,
          duration: this._duration,
          buffered: this._buffered,
        });
        // Sync DOM subtitle overlay — AVPlay drives the timeline so we
        // tick on every reported play-time update rather than running
        // our own rAF loop.
        this.updateSubtitleAt(this._currentTime);
        if (!this.firstFrameEmitted && ms > 0) {
          this.firstFrameEmitted = true;
          this.emit('firstFrame', undefined);
        }
      },
      onerror: (err) => {
        this.emit('error', { code: -1, message: String(err) });
        this.emit('stateChanged', { state: 'error' });
      },
      onstreamcompleted: () => {
        this.emit('stateChanged', { state: 'ended' });
        this.emit('ended', undefined);
      },
      onevent: () => { /* opaque AVPlay events — ignore for now */ },
    });

    return new Promise<void>((resolve, reject) => {
      try {
        webapis.avplay.prepareAsync(
          () => {
            try {
              this._duration = (webapis.avplay.getDuration() ?? 0) / 1000;
            } catch {
              this._duration = 0;
            }
            this.populateAudioTracks();
            // setDisplayRect AFTER prepare (Samsung sample order).
            this.applyDisplayRect();
            webapis.avplay.play();
            this._paused = false;
            // We seeded the resume position in IDLE pre-prepare; record
            // it locally so the seekbar shows the right starting offset
            // before AVPlay's first `oncurrentplaytime` tick.
            if (startTime && startTime > 0) this._currentTime = startTime;
            this.emit('stateChanged', { state: 'playing' });
            resolve();
          },
          (err) => {
            try { webapis.avplay.close(); } catch { /* fine */ }
            document.documentElement.classList.remove('native-player-active');
            this.emit('error', { code: -1, message: 'AVPlay prepare failed: ' + String(err) });
            reject(new Error('AVPlay prepare failed: ' + String(err)));
          },
        );
      } catch (e) {
        try { webapis.avplay.close(); } catch { /* fine */ }
        document.documentElement.classList.remove('native-player-active');
        const msg = 'AVPlay prepareAsync threw: ' + (e instanceof Error ? e.message : String(e));
        this.emit('error', { code: -1, message: msg });
        reject(new Error(msg));
      }
    });
  }

  async unload(): Promise<void> {
    try {
      const s = webapis.avplay.getState();
      if (s !== 'NONE' && s !== 'IDLE') webapis.avplay.stop();
      webapis.avplay.close();
    } catch {
      /* OK */
    }
  }

  // ── Playback ────────────────────────────────────────────────────────

  async play(): Promise<void> {
    try {
      const s = webapis.avplay.getState();
      if (s === 'PAUSED' && typeof webapis.avplay.resume === 'function') {
        webapis.avplay.resume();
      } else if (s !== 'PLAYING') {
        webapis.avplay.play();
      }
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay play failed: ' + String(e) });
    }
    this._paused = false;
    this.emit('stateChanged', { state: 'playing' });
  }

  async pause(): Promise<void> {
    try {
      webapis.avplay.pause();
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay pause failed: ' + String(e) });
    }
    this._paused = true;
    this.emit('stateChanged', { state: 'paused' });
  }

  async seek(position: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        webapis.avplay.seekTo(
          Math.round(position * 1000),
          () => {
            this._currentTime = position;
            resolve();
          },
          async (err) => {
            // AVPlay's failure callback fires whenever it can't
            // satisfy the seek — typically a big backward seek past
            // the buffered range, where AVPlay's HLS engine doesn't
            // retry the segment fetch on its own and ends up stuck
            // in a half-paused state (next `play()` throws). Reload
            // the stream at the target position to recover.
            // eslint-disable-next-line no-console
            console.warn(
              '[TizenEngine] seek failed → reloading at target:',
              err,
            );
            if (!this._lastLoadedUrl) {
              reject(new Error(`seek failed: ${err}`));
              return;
            }
            try {
              await this.load(this._lastLoadedUrl, position);
              await this.play();
              resolve();
            } catch (e) {
              reject(e);
            }
          },
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── State getters ───────────────────────────────────────────────────

  get currentTime(): number {
    try {
      return webapis.avplay.getCurrentTime() / 1000;
    } catch {
      return this._currentTime;
    }
  }
  get duration(): number {
    return this._duration;
  }
  get paused(): boolean {
    return this._paused;
  }
  get buffered(): number {
    return this._buffered;
  }
  get playbackRate(): number {
    return this._playbackRate;
  }
  set playbackRate(_rate: number) {
    // AVPlay supports `setSpeed(rate)` on Tizen 4.0+ but it's a separate
    // API (`webapis.avplay.setSpeed`). Skipped in V1 — controls UI doesn't
    // expose rate changes on TV.
  }
  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = v;
    // AVPlay uses the system volume — no per-stream knob. Mute is the
    // closest equivalent and is wired through `muted` below.
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    // No web-level mute API on AVPlay; rely on the TV remote / system.
  }

  // ── Audio tracks ────────────────────────────────────────────────────

  private populateAudioTracks() {
    try {
      const all = webapis.avplay.getTotalTrackInfo() ?? [];
      const audioTracks = all.filter((t) => t.type === 'AUDIO');
      // Default-active: AVPlay starts on the first audio track unless
      // the manifest's `DEFAULT=YES` rendition is elsewhere. We don't
      // have a getCurrent API to ask, so we trust index 0 until the
      // user picks otherwise.
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
    } catch {
      /* getTotalTrackInfo throws before AVPlay enters READY — caller
         retries via the audioTracksChanged listener once the pipeline
         publishes its tracks. */
    }
  }

  /** Emit the cached track list with the `selected` flag set on whichever
   *  index `_currentAudioIndex` currently points at. The base
   *  `AudioTrack` type from the engine interface doesn't expose
   *  `selected`, but the native engine fans it in via an extra field
   *  (see `player.ts` `audioTracksChanged` handler) and the player UI
   *  reads it from the emission. */
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
      // Re-emit so the picker reflects the new active language. AVPlay
      // doesn't fire its own "track changed" event we can listen for.
      this.emitAudioTracks();
    } catch (e) {
      this.emit('error', { code: -1, message: 'AVPlay setSelectTrack audio failed: ' + String(e) });
    }
  }

  // ── Subtitles (DOM-rendered overlay) ────────────────────────────────

  async addTextTrack(url: string, language: string, label: string): Promise<unknown> {
    return { url, language, label };
  }

  selectTextTrack(track: unknown): void {
    if (!track || typeof track !== 'object') {
      this.subtitleVisible = false;
      this.parsedCues = [];
      this.renderSubtitle('');
      return;
    }
    const url = (track as { url?: string }).url;
    if (!url) return;
    this.subtitleVisible = true;
    void this.loadVttCues(url);
  }

  setTextVisibility(visible: boolean): void {
    this.subtitleVisible = visible;
    if (!visible) this.renderSubtitle('');
  }

  /** Match the subtitle settings UX wired on web/native via the shared
   *  preset maps from `player-settings.service` — same enums the Shaka
   *  path consumes (`small/normal/large/xlarge`,
   *  `white/yellow/green/cyan`, `none/drop/outline/raised`,
   *  `transparent/semi/black`). `bottomMargin` is in vh. */
  setSubtitleStyle(style: {
    size?: string;
    color?: string;
    shadow?: string;
    background?: string;
    bottomMargin?: number;
  }): void {
    const el = this.ensureSubtitleEl();
    if (!el) return;
    if (style.size) {
      el.style.fontSize = SUBTITLE_SIZE_MAP[style.size] ?? SUBTITLE_SIZE_MAP['normal'];
    }
    if (style.color) {
      el.style.color = SUBTITLE_COLOR_MAP[style.color] ?? SUBTITLE_COLOR_MAP['white'];
    }
    if (style.shadow) {
      el.style.textShadow = SUBTITLE_SHADOW_MAP[style.shadow] ?? SUBTITLE_SHADOW_MAP['drop'];
    }
    if (style.background) {
      el.style.background = SUBTITLE_BG_MAP[style.background] ?? SUBTITLE_BG_MAP['transparent'];
    }
    if (typeof style.bottomMargin === 'number') {
      el.style.bottom = `${Math.max(0, style.bottomMargin)}vh`;
    }
  }

  private async loadVttCues(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('VTT fetch ' + res.status);
      const raw = await res.text();
      this.parsedCues = this.parseVtt(raw);
    } catch (e) {
      this.parsedCues = [];
      // eslint-disable-next-line no-console
      console.warn('[TizenEngine] subtitle load failed:', e);
    }
  }

  private ensureSubtitleEl(): HTMLDivElement | null {
    if (this.subtitleEl?.isConnected) return this.subtitleEl;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.id = 'fliks-avplay-subtitle';
    // Defaults match the "no settings yet" state: transparent backdrop,
    // white text, drop-shadow legibility. `setSubtitleStyle` overlays
    // the user's choices on top of these.
    el.style.cssText = [
      'position: fixed',
      'left: 50%',
      'bottom: 10vh',
      'transform: translateX(-50%)',
      'max-width: 80vw',
      'padding: 6px 14px',
      'background: transparent',
      'color: #fff',
      'font-size: 3vh',
      'font-weight: 500',
      'line-height: 1.3',
      'text-align: center',
      'text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9)',
      'pointer-events: none',
      'z-index: 1000',
      'white-space: pre-wrap',
      'display: none',
    ].join(';');
    document.body.appendChild(el);
    this.subtitleEl = el;
    return el;
  }

  private renderSubtitle(text: string): void {
    const el = this.ensureSubtitleEl();
    if (!el) return;
    if (text === this.lastCueText) return;
    this.lastCueText = text;
    if (text) {
      el.innerHTML = text;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  private updateSubtitleAt(timeSec: number): void {
    if (!this.subtitleVisible) {
      if (this.lastCueText) this.renderSubtitle('');
      return;
    }
    const cues = this.parsedCues;
    if (!cues.length) return;
    const active = cues.find((c) => timeSec >= c.start && timeSec <= c.end);
    this.renderSubtitle(active?.text ?? '');
  }

  private parseVtt(raw: string): VttCue[] {
    const cues: VttCue[] = [];
    const blocks = raw.replace(/\r\n/g, '\n').split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) continue;
      const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());
      const start = this.vttTimeToSec(startStr);
      const end = this.vttTimeToSec(endStr);
      if (isNaN(start) || isNaN(end)) continue;
      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      const text = textLines.join('<br>').replace(/<\/?[^>]*>/g, (tag) => {
        // Allow <b>, <i>, <u>, <br> — strip everything else so we can
        // safely use `innerHTML` (parsed VTT is from our own backend
        // but the source files come from third-party subtitle DBs).
        if (/^<\/?(b|i|u|br)\s*\/?>$/i.test(tag)) return tag;
        return '';
      });
      if (text) cues.push({ start, end, text });
    }
    return cues;
  }

  private vttTimeToSec(ts: string): number {
    const clean = ts.split(' ')[0];
    const parts = clean.split(':');
    if (parts.length === 3) {
      return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
      return +parts[0] * 60 + parseFloat(parts[1]);
    }
    return NaN;
  }

  // ── Quality — AVPlay handles ABR internally ────────────────────────

  getVariantTracks(): unknown[] {
    return [];
  }
  selectVariantTrack(_track: unknown, _clearBuffer?: boolean): void {
    /* AVPlay does its own ABR via the HLS master playlist; manual
       variant pinning would require setStreamingProperty('AVAILABLE_BITRATE',
       '<min~max>'). Deferred. */
  }
  configure(_config: unknown): void {
    /* no-op — Shaka-specific. */
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): EngineStats {
    return {
      droppedFrames: 0,
    };
  }
}

interface AvplayTrackMeta {
  language?: string;
  label?: string;
}

/**
 * `extra_info` is a JSON-ish blob whose shape depends on the firmware.
 * 2020+ Q-series TVs return a stringified JSON object with `language`
 * and `channels`; older builds return a flat ":" / "|"-separated string.
 * We try JSON first, then fall back to a permissive split.
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
