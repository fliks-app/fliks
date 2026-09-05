import {
  AbstractPlaybackEngine,
  type PlaybackEngine,
  type AudioTrack,
  type EngineStats,
  pausedFlagForState,
} from './playback-engine';
import {
  NATIVE_SUBTITLE_SIZE_SCALE,
  SUBTITLE_FG_HEX,
  SUBTITLE_BG_ARGB,
  SUBTITLE_EDGE_KEY,
} from '../../utils/subtitle-presets';
import { normalizeLangCode } from '../../utils/language.utils';
import {
  desktopBridge,
  type DesktopEvent,
  type DesktopSubtitleTrack,
  type FliksDesktopApi,
} from '../../plugins/desktop-player.bridge';

/**
 * PlaybackEngine backed by the Electron desktop shell's embedded mpv player
 * (window.fliksDesktop). mpv renders into a window behind the transparent UI —
 * the same model as NativeEngine on mobile, so this mirrors that engine: the
 * desktop bridge replaces the Capacitor NativePlayer plugin, and mpv's event
 * stream replaces the native window CustomEvents.
 */
export class DesktopEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  private readonly bridge: FliksDesktopApi = desktopBridge();
  private unsubscribe: (() => void) | null = null;

  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _audioTracks: AudioTrack[] = [];

  /** Set in destroy() so a leaked late event (the mpv player is a persistent
   *  singleton) can't drive a torn-down engine into recovery. */
  private dead = false;

  private _initialized = false;

  // ── Subtitles ──
  // mpv renders subtitles in its own pipeline. Tracks are loaded sidecar via
  // `sub-add` (addTextTrack), and selection is by (language, forced) against the
  // track list mpv reports, mirroring NativeEngine.
  private _activeTrackId: string | null = null;
  private _desiredSubtitle: { language: string; forced: boolean; embIndex: number | null } | null = null;
  private _nativeSubtitleTracks: DesktopSubtitleTrack[] = [];
  /** mpv's own audio track ids, indexed parallel to the `audio-<i>` ids the
   *  player expects (mpv ids are bare ints; the player keys off the prefix). */
  private _mpvAudioIds: string[] = [];
  private _fullscreen = false;
  /** Preferred audio language (from configure()); passed to mpv as `alang` at
   *  load so it auto-picks the matching rendition on every reconfig. */
  private _preferredAudioLanguage?: string;
  private _videoCrop?: string;

  private _subtitleStyle: {
    fontScale: number;
    foregroundColor: string;
    backgroundColor: string;
    edgeType: string;
    bottomMarginPercent: number;
  } | null = null;
  private _fillScreen = false;

  // ── Lifecycle ──

  async init(_container: HTMLElement): Promise<void> {
    // The video window + mpv already exist in the Electron main process; just
    // wire the event stream (and re-apply any style set before init).
    this.subscribe();
    this._initialized = true;
    if (this._subtitleStyle) {
      this.bridge.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    this.dead = true;
    this._initialized = false;
    // The compositor window is the app window: leave fullscreen with the
    // player, whatever route change tore it down.
    if (this._fullscreen) await this.setFullscreen(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this._activeTrackId = null;
    this.clearHandlers();
    await this.bridge.stop().catch(() => {});
  }

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (this.dead) return;
    this.resetFirstFrame();
    // Fresh media → fresh tracks; drop the prior list/id map so a same-count
    // track emission for the new stream isn't swallowed as a no-op downstream.
    this._audioTracks = [];
    this._mpvAudioIds = [];
    await this.bridge.load({
      url,
      startTime,
      headers,
      audioLanguage: this._preferredAudioLanguage,
      videoCrop: this._videoCrop,
    });
    if (this._subtitleStyle) {
      await this.bridge.setSubtitleStyle(this._subtitleStyle);
    }
    if (this._fillScreen) {
      await this.bridge.setFillScreen(true).catch(() => {});
    }
    // Fresh media → fresh track ids; let the desired selection re-apply once
    // mpv reports the new track list (tracksChanged).
    this._activeTrackId = null;
    this._nativeSubtitleTracks = [];
  }

  async unload(): Promise<void> {
    await this.bridge.stop();
    this._currentTime = 0;
    this._duration = 0;
  }

  // ── Playback ──

  async play(): Promise<void> {
    if (this.dead) return;
    await this.bridge.play();
    this._paused = false;
  }

  async pause(): Promise<void> {
    if (this.dead) return;
    await this.bridge.pause();
    this._paused = true;
  }

  async seek(position: number): Promise<void> {
    if (this.dead) return;
    await this.bridge.seek(position);
    // Do NOT optimistically set _currentTime = position. Doing so makes the
    // player's pollSeekConverge see instant convergence and drop seekLocked
    // within ms — before the seek actually lands — which both lets the bar fall
    // back to the old position and defeats the seek spinner. The real position
    // arrives via timeUpdate (the addon force-pushes it on PLAYBACK_RESTART), so
    // seekLocked stays up for the true duration of the seek.
  }

  // ── State ──

  get currentTime(): number {
    return this._currentTime;
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
  set playbackRate(rate: number) {
    this._playbackRate = rate;
    this.bridge.setPlaybackRate(rate).catch(() => {});
  }

  // Desktop has an in-app volume control (unlike mobile, which defers to the
  // OS slider): drive mpv's volume/mute directly.
  get volume(): number {
    return this._volume;
  }
  readonly supportsVolume = true;

  set volume(v: number) {
    this._volume = v;
    this.bridge.setVolume(Math.round(v * 100)).catch(() => {});
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.bridge.setMuted(m).catch(() => {});
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    // The player sends `audio-<i>` ids; translate back to mpv's own aid.
    const idx = parseInt(id.replace(/^audio-/, ''), 10);
    const mpvId = this._mpvAudioIds[idx] ?? String(idx + 1);
    await this.bridge.selectAudioTrack(mpvId);
  }

  /** Toggle the native (SDL) compositor window fullscreen. */
  async setFullscreen(enabled: boolean): Promise<void> {
    this._fullscreen = enabled;
    await this.bridge.setFullscreen(enabled).catch(() => {});
  }
  get fullscreen(): boolean {
    return this._fullscreen;
  }

  // ── Subtitles ──

  async addTextTrack(
    url: string,
    language: string,
    label: string,
    forced = false,
  ): Promise<{ language: string; forced: boolean }> {
    // Sidecar load (mpv `sub-add`): mpv parses the VTT once and seeks within it
    // natively. The alternative — an HLS SUBTITLES rendition — is a single
    // segment over the whole VTT that mpv's ffmpeg HLS demuxer re-reads on each
    // seek, re-injecting every cue without clearing the prior set, so cues stack.
    // `sub-add` is idempotent per URL (main passes `cached`), so re-selecting the
    // same subtitle doesn't duplicate the track. mpv then surfaces it in the
    // track list; selection resolves against that list (see resolveSubtitle).
    if (url) await this.bridge.subAdd(url, label, language).catch(() => {});
    return { language, forced };
  }

  selectTextTrack(track: any): void {
    this._desiredSubtitle =
      track && typeof track === 'object' && track.language
        ? { language: track.language, forced: !!track.forced, embIndex: track.embIndex ?? null }
        : null;
    this.resolveSubtitle();
  }

  setTextVisibility(visible: boolean): void {
    if (!visible) {
      this._desiredSubtitle = null;
      this._activeTrackId = null;
      this.bridge.selectSubtitleTrack(null).catch(() => {});
    }
  }

  private resolveSubtitle(): void {
    if (!this._desiredSubtitle) {
      // No subtitle wanted → assert off. mpv auto-selects one otherwise; the
      // app is the sole source of truth for subtitle selection.
      this._activeTrackId = null;
      this.bridge.selectSubtitleTrack(null).catch(() => {});
      return;
    }
    const { language, forced, embIndex } = this._desiredSubtitle;
    const want = normalizeLangCode(language);
    const tracks = this._nativeSubtitleTracks;
    // (lang+forced) → lang → the picked ordinal (embedded subs often report
    // lang "und") → first track, so a deliberate pick is never silently dropped.
    const match =
      tracks.find((t) => normalizeLangCode(t.language) === want && !!t.forced === !!forced) ??
      tracks.find((t) => normalizeLangCode(t.language) === want) ??
      (embIndex != null ? tracks[embIndex] : undefined) ??
      (tracks.length ? tracks[0] : undefined);
    const selectedId = match?.id ?? null;
    if (selectedId) {
      this._activeTrackId = selectedId;
      this.bridge.selectSubtitleTrack(selectedId).catch(() => {});
    }
  }

  /** Match NativeEngine.setSubtitleStyle: maps the player's preset keys to the
   *  native style payload and pushes it to mpv. */
  setSubtitleStyle(settings: {
    size: string;
    color: string;
    shadow: string;
    background: string;
    bottomMargin: number;
  }): void {
    this._subtitleStyle = {
      fontScale: NATIVE_SUBTITLE_SIZE_SCALE[settings.size] ?? 1.0,
      foregroundColor: SUBTITLE_FG_HEX[settings.color] ?? '#FFFFFF',
      backgroundColor: SUBTITLE_BG_ARGB[settings.background] ?? 'transparent',
      edgeType: SUBTITLE_EDGE_KEY[settings.shadow] ?? 'drop_shadow',
      bottomMarginPercent: settings.bottomMargin,
    };
    if (this._initialized) {
      this.bridge.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  /** Match NativeEngine.setFillScreen: crop-to-fill instead of letterbox. */
  setFillScreen(fill: boolean): void {
    this._fillScreen = fill;
    this.bridge.setFillScreen(fill).catch(() => {});
  }

  // ── Stats ──

  getStats(): EngineStats {
    return { droppedFrames: 0 };
  }

  // ── Quality ──
  // mpv selects one HLS variant when it opens the master playlist and never
  // switches mid-playback — there is no in-engine ABR to drive. The rung is
  // pinned server-side via `startQuality` before load (player.ts
  // resolveStartQuality), so variant pinning here is a no-op (kept for the
  // PlaybackEngine contract).
  getVariantTracks(): any[] {
    return [];
  }
  selectVariantTrack(_track: any, _clearBuffer?: boolean): void {
    /* no-op: mpv already opened its single pinned variant */
  }
  configure(config: any): void {
    // No ABR knob to honour (see above); the only one is the preferred audio
    // language, threaded to mpv as `alang` on the next load so it auto-selects
    // the right rendition on every reconfig (mirrors the Shaka engine's
    // preferredAudioLanguage).
    if (config && typeof config.preferredAudioLanguage === 'string') {
      this._preferredAudioLanguage = config.preferredAudioLanguage || undefined;
    }
    // Black-bar crop: mpv cuts it at the VO for free, so the backend copies the
    // bitstream instead of re-encoding. Held here and re-applied on every load,
    // like the subtitle style and fill-screen above.
    if (config && 'videoCrop' in config) {
      this._videoCrop = config.videoCrop || undefined;
    }
  }

  // ── Event bridge ──

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.bridge.on((event) => this.onEvent(event));
  }

  private onEvent(event: DesktopEvent): void {
    if (this.dead) return;
    switch (event.type) {
      case 'stateChanged': {
        const state = event.payload.state;
        const paused = pausedFlagForState(state);
        if (paused !== undefined) this._paused = paused;
        this.emit('stateChanged', { state });
        if (state === 'ended') this.emit('ended', undefined);
        break;
      }
      case 'timeUpdate': {
        const d = event.payload;
        this._currentTime = d.position;
        this._duration = d.duration;
        this._buffered = d.buffered;
        this.emit('timeUpdate', d);
        // firstFrame is driven by mpv's authoritative 'playback-restart' (the
        // 'firstFrame' case). Deriving it from a position delta mis-fires on a
        // stale time-pos the persistent mpv replays after a reopen, which would
        // flip a fresh engine into the sessionExpired recovery path.
        break;
      }
      case 'tracksChanged': {
        const raw = event.payload.audioTracks ?? [];
        // Emit the `audio-<i>` id contract the player keys off; keep mpv's real
        // ids for selectAudioTrack to map back.
        this._mpvAudioIds = raw.map((t) => t.id);
        this._audioTracks = raw.map((t, i) => ({
          id: `audio-${i}`,
          language: t.language,
          label: t.label,
          selected: !!t.selected,
        }));
        this.emit('audioTracksChanged', { tracks: this._audioTracks });
        this._nativeSubtitleTracks = event.payload.subtitleTracks ?? [];
        this.resolveSubtitle();
        break;
      }
      case 'firstFrame': {
        if (this.firstFrameEmitted) break;
        this.emitFirstFrameOnce();
        // The persistent mpv may not fire a pause-property change on a fresh
        // load (it was already unpaused from a prior session), so the UI's
        // paused signal would stay stuck on its default. Assert the playing
        // state once frames start flowing so the controls show pause, not play.
        this._paused = false;
        this.emit('stateChanged', { state: 'playing' });
        break;
      }
      case 'error': {
        // mpv can't expose the failing segment's HTTP status either; mirror the
        // native heuristic — first error after a frame played → try one
        // session-expired recovery before surfacing a fatal error.
        if (this.maybeEmitSessionExpired()) return;
        const { code, message, detail } = event.payload;
        // mpv's generic message ("loading failed") plus the concrete cause it
        // logged (TLS verify, HTTP status, unsupported codec) so the error card
        // shows why, not just that.
        const composed = detail ? `${message} — ${detail}` : message;
        // code 2 (MEDIA_ERR_NETWORK) is mpv's own TLS/libcurl transport
        // classification; source:'media' routes it through the shared
        // network/abort classifier instead of a decode-path label such as
        // Dolby Vision.
        this.emit(
          'error',
          code === 2 ? { code, message: composed, source: 'media' } : { code, message: composed },
        );
        break;
      }
      default:
        break;
    }
  }
}
