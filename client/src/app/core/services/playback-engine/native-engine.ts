import { Capacitor } from '@capacitor/core';
import { NativePlayer } from '../../plugins/native-player.plugin';
import {
  AbstractPlaybackEngine,
  type PlaybackEngine,
  type AudioTrack,
  type EngineStats,
  type PlaybackState,
} from './playback-engine';
import {
  NATIVE_SUBTITLE_SIZE_SCALE,
  SUBTITLE_FG_HEX,
  SUBTITLE_BG_ARGB,
  SUBTITLE_EDGE_KEY,
} from '../../utils/subtitle-presets';

interface VttCue {
  start: number;
  end: number;
  text: string;
}

/**
 * PlaybackEngine implementation backed by the NativePlayer Capacitor plugin
 * (ExoPlayer on Android, AVPlayer on iOS).
 *
 * The native player renders behind the WebView — the Angular UI sits on top.
 */
export class NativeEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _state: PlaybackState = 'idle';
  private _audioTracks: AudioTrack[] = [];
  private _variantTracks: any[] = [];

  private listeners: Array<{ event: string; fn: EventListener }> = [];

  /** Guards against double-emit of 'firstFrame' (engine listeners use
   *  it to clear the loading veil — flipping it twice is harmless but
   *  the position-advance fallback below would otherwise fire on every
   *  later timeUpdate). Reset on each load(). */
  private firstFrameEmitted = false;

  /** One-shot guard for the optimistic-recovery branch in the
   *  `nativePlayerError` bridge. ExoPlayer / AVPlayer can't tell us the
   *  HTTP status that triggered the error, so the first error during
   *  stable playback is routed to `sessionExpired` (which makes the
   *  player call /playback-info + reload). If a second error follows
   *  before the next load() clears the flag, fall through to a real
   *  fatal `error` so the UI isn't stuck retrying a broken stream. */
  private recoveryAttempted = false;
  /** Last `timeUpdate.position` seen, used to detect that playback is
   *  actually advancing (Android's onRenderedFirstFrame is unreliable on
   *  some devices: it fires late or never on transcode → ABR switches,
   *  leaving the UI stuck on the loading spinner even though the stream
   *  is playing). When position grows between two updates, we know
   *  frames are decoding and can fire 'firstFrame' ourselves as a
   *  belt-and-suspenders signal. */
  private lastTimeUpdatePos = -1;

  // ── Native subtitle overlay (iOS) ──
  private readonly _isIos = Capacitor.getPlatform() === 'ios';
  private _parsedTracks = new Map<string, VttCue[]>();
  private _activeTrackId: string | null = null;
  private _subtitleVisible = false;
  private _lastCueText = '';

  // ── Lifecycle ──

  private _initialized = false;

  async init(_container: HTMLElement): Promise<void> {
    // Pass 0,0 with -1,-1 (MATCH_PARENT) to fill the entire screen.
    // The native SurfaceView sits behind the transparent WebView.
    await NativePlayer.create({ x: 0, y: 0, width: -1, height: -1 });
    this._initialized = true;
    this.bindWindowEvents();
    if (this._subtitleStyle) {
      NativePlayer.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    this._initialized = false;
    this.unbindWindowEvents();
    this.destroySubtitleOverlay();
    await NativePlayer.destroy();
  }

  // ── Loading ──

  private _offline = false;

  /** Mark next load() as offline — uses CacheDataSource on Android. */
  setOffline(offline: boolean) { this._offline = offline; }

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    this.firstFrameEmitted = false;
    this.recoveryAttempted = false;
    this.lastTimeUpdatePos = -1;
    const subtitles = this._preloadedSubtitles.length > 0
      ? this._preloadedSubtitles
      : undefined;
    await NativePlayer.load({ url, startTime, headers, subtitles, offline: this._offline });

    // Apply subtitle style settings
    if (this._subtitleStyle) {
      await NativePlayer.setSubtitleStyle(this._subtitleStyle);
    }

    // Restore the previously-active subtitle selection. ExoPlayer disables
    // text tracks by default on every new MediaItem, so a silent reload
    // (session-expired recovery, cast handoff) would otherwise drop the
    // user's pick and leave the SubtitleView blank. The plugin's
    // pendingSubtitleTrackId queues this until onTracksChanged fires.
    if (this._activeTrackId) {
      NativePlayer.selectSubtitleTrack({ id: this._activeTrackId }).catch(() => {});
    }
  }

  private _subtitleStyle: {
    fontScale: number;
    foregroundColor: string;
    backgroundColor: string;
    edgeType: string;
    bottomMarginPercent: number;
  } | null = null;

  /** Set subtitle appearance. Call before load() or anytime after. */
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
      NativePlayer.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  private _preloadedSubtitles: { url: string; language: string; label: string }[] = [];

  /** Set subtitles to include in the native MediaItem at load time. */
  setPreloadedSubtitles(subs: { url: string; language: string; label: string }[]): void {
    this._preloadedSubtitles = subs;
    this._subtitleUrls = subs.map((s) => s.url);
  }

  async unload(): Promise<void> {
    await NativePlayer.stop();
    this._state = 'idle';
    this._currentTime = 0;
    this._duration = 0;
  }

  // ── Playback ──

  async play(): Promise<void> {
    await NativePlayer.play();
    this._paused = false;
  }

  async pause(): Promise<void> {
    await NativePlayer.pause();
    this._paused = true;
  }

  async seek(position: number): Promise<void> {
    await NativePlayer.seek({ position });
    this._currentTime = position;
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
    NativePlayer.setPlaybackRate({ rate });
  }

  // Volume + muted are intentionally local-only. Native playback uses
  // the system volume slider on Android / iOS, so the in-app slider is
  // hidden under `isMobileTouch()` in `player-controls.html`. The
  // setters exist to satisfy the PlaybackEngine contract uniformly with
  // ShakaEngine, but they don't reach the native player — the host OS
  // is the source of truth for output level.
  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = v; }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) { this._muted = m; }

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    await NativePlayer.selectAudioTrack({ id });
  }

  // ── Subtitles ──
  // Subtitles are preloaded at load() time. addTextTrack finds the matching
  // preloaded track by URL and returns its ExoPlayer text track index.

  private _subtitleUrls: string[] = [];

  /** Store subtitle URLs passed at load() for matching later. */
  setSubtitleUrls(urls: string[]): void {
    this._subtitleUrls = urls;
  }

  async addTextTrack(
    url: string,
    _language: string,
    _label: string,
  ): Promise<string> {
    // Find the index of this URL in the preloaded subtitles
    const idx = this._subtitleUrls.indexOf(url);
    const trackId = idx >= 0 ? `text-${idx}` : `text-0`;

    // On iOS: fetch and parse WebVTT for HTML overlay rendering
    if (this._isIos && !this._parsedTracks.has(trackId)) {
      try {
        const resp = await fetch(url);
        const vtt = await resp.text();
        this._parsedTracks.set(trackId, this.parseVtt(vtt));
      } catch {
        this._parsedTracks.set(trackId, []);
      }
    }

    return trackId;
  }

  selectTextTrack(track: any): void {
    const id = typeof track === 'string' ? track : null;
    this._activeTrackId = id;
    if (this._isIos) {
      this._subtitleVisible = !!id;
      this.updateSubtitleOverlay();
    } else {
      NativePlayer.selectSubtitleTrack({ id });
    }
  }

  setTextVisibility(visible: boolean): void {
    if (this._isIos) {
      this._subtitleVisible = visible;
      if (!visible) {
        this._activeTrackId = null;
        this.updateSubtitleOverlay();
      }
    } else if (!visible) {
      this._activeTrackId = null;
      NativePlayer.selectSubtitleTrack({ id: null });
    }
  }

  // ── Stats ──

  getStats(): EngineStats {
    return { droppedFrames: 0 };
  }

  // ── Quality ──
  // ExoPlayer handles ABR internally. We control it via max resolution constraints.

  getVariantTracks(): any[] {
    return this._variantTracks;
  }

  selectVariantTrack(track: any, _clearBuffer?: boolean): void {
    // Set max resolution to the selected track's resolution
    if (track?.height) {
      NativePlayer.setMaxResolution({
        width: track.width ?? track.height * 2,
        height: track.height,
      });
    }
  }

  configure(config: any): void {
    // Handle ABR enable/disable
    if (config?.abr?.enabled === true) {
      // Auto mode: remove resolution constraints
      NativePlayer.setMaxResolution({ width: 0, height: 0 });
    }
  }

  // ── Window event bridge ──

  private bindWindowEvents(): void {
    const bind = (eventName: string, fn: EventListener) => {
      window.addEventListener(eventName, fn);
      this.listeners.push({ event: eventName, fn });
    };

    bind('nativePlayerStateChanged', (e: Event) => {
      const detail = (e as CustomEvent).detail;
      this._state = detail.state;
      this._paused = detail.state === 'paused' || detail.state === 'idle';
      this.emit('stateChanged', { state: detail.state });
    });

    bind('nativePlayerTimeUpdate', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._currentTime = d.position;
      this._duration = d.duration;
      this._buffered = d.buffered;
      this.emit('timeUpdate', d);
      this.updateSubtitleOverlay();
      // Fallback for the missing onRenderedFirstFrame case: native only
      // fires nativePlayerTimeUpdate when `player.isPlaying()`, so a
      // position that grows between two updates is a strong signal that
      // decoded frames are flowing. We use the second observation (not
      // the first) because a seek-resume's initial update can land at
      // position=T before any frame has rendered.
      if (
        !this.firstFrameEmitted &&
        this.lastTimeUpdatePos >= 0 &&
        d.position > this.lastTimeUpdatePos
      ) {
        this.firstFrameEmitted = true;
        this.emit('firstFrame', undefined);
      }
      this.lastTimeUpdatePos = d.position;
    });

    bind('nativePlayerError', (e: Event) => {
      const d = (e as CustomEvent).detail;
      // ExoPlayer / AVPlayer hide the HTTP status of the failing
      // segment fetch — we can't tell a 410 (session expired) from a
      // 5xx (ffmpeg crash). Heuristic: if a frame has played and we
      // haven't tried recovery yet, treat the first error as a
      // possible session-expired and let the player attempt a single
      // /playback-info + reload before surfacing a fatal error.
      if (this.firstFrameEmitted && !this.recoveryAttempted) {
        this.recoveryAttempted = true;
        this.emit('sessionExpired', undefined);
        return;
      }
      this._state = 'error';
      this.emit('error', d);
    });

    bind('nativePlayerTracksChanged', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._audioTracks = d.audioTracks ?? [];
      this.emit('audioTracksChanged', { tracks: this._audioTracks });
    });

    bind('nativePlayerFirstFrame', () => {
      if (this.firstFrameEmitted) return;
      this.firstFrameEmitted = true;
      this.emit('firstFrame', undefined);
    });
  }

  private unbindWindowEvents(): void {
    for (const { event, fn } of this.listeners) {
      window.removeEventListener(event, fn);
    }
    this.listeners = [];
  }

  // ── Native Subtitle Overlay (iOS) ──

  private updateSubtitleOverlay(): void {
    if (!this._isIos) return;
    if (!this._subtitleVisible || !this._activeTrackId) {
      if (this._lastCueText) {
        this._lastCueText = '';
        NativePlayer.setSubtitleText({ text: '' }).catch(() => {});
      }
      return;
    }
    const cues = this._parsedTracks.get(this._activeTrackId);
    if (!cues) return;
    const t = this._currentTime;
    const active = cues.find(c => t >= c.start && t <= c.end);
    const text = active?.text?.replace(/<br>/g, '\n').replace(/<[^>]*>/g, '') ?? '';
    if (text !== this._lastCueText) {
      this._lastCueText = text;
      NativePlayer.setSubtitleText({ text }).catch(() => {});
    }
  }

  private destroySubtitleOverlay(): void {
    if (this._isIos) {
      NativePlayer.setSubtitleText({ text: '' }).catch(() => {});
    }
    this._parsedTracks.clear();
    this._activeTrackId = null;
    this._subtitleVisible = false;
    this._lastCueText = '';
  }

  private parseVtt(raw: string): VttCue[] {
    const cues: VttCue[] = [];
    const blocks = raw.replace(/\r\n/g, '\n').split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const timeLine = lines.find(l => l.includes('-->'));
      if (!timeLine) continue;
      const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
      const start = this.vttTimeToSec(startStr);
      const end = this.vttTimeToSec(endStr);
      if (isNaN(start) || isNaN(end)) continue;
      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      const text = textLines.join('<br>').replace(/<\/?[^>]*>/g, (tag) => {
        // Allow <b>, <i>, <u>, <br> — strip everything else
        if (/^<\/?(b|i|u|br)\s*\/?>$/i.test(tag)) return tag;
        return '';
      });
      if (text) cues.push({ start, end, text });
    }
    return cues;
  }

  private vttTimeToSec(ts: string): number {
    // Remove positioning metadata (e.g. "00:01:23.456 align:start")
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
}
