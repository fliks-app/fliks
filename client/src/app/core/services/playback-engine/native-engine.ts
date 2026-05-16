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
  private positionPoll: ReturnType<typeof setInterval> | null = null;

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
    this.stopPositionPoll();
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
    const subtitles = this._preloadedSubtitles.length > 0
      ? this._preloadedSubtitles
      : undefined;
    await NativePlayer.load({ url, startTime, headers, subtitles, offline: this._offline });

    // Apply subtitle style settings
    if (this._subtitleStyle) {
      await NativePlayer.setSubtitleStyle(this._subtitleStyle);
    }

    this.startPositionPoll();
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
    this.stopPositionPoll();
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
    if (this._isIos) {
      this._activeTrackId = id;
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
    });

    bind('nativePlayerError', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._state = 'error';
      this.emit('error', d);
    });

    bind('nativePlayerTracksChanged', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._audioTracks = d.audioTracks ?? [];
      this.emit('audioTracksChanged', { tracks: this._audioTracks });
    });

    bind('nativePlayerFirstFrame', () => {
      this.emit('firstFrame', undefined);
    });
  }

  private unbindWindowEvents(): void {
    for (const { event, fn } of this.listeners) {
      window.removeEventListener(event, fn);
    }
    this.listeners = [];
  }

  // ── Position polling (fallback if native events are sparse) ──

  private startPositionPoll(): void {
    this.stopPositionPoll();
    this.positionPoll = setInterval(async () => {
      try {
        const pos = await NativePlayer.getPosition();
        this._currentTime = pos.position;
        this._duration = pos.duration;
        this._buffered = pos.buffered;
        this.emit('timeUpdate', pos);
        this.updateSubtitleOverlay();
      } catch {
        /* player might be destroyed */
      }
    }, 1000);
  }

  private stopPositionPoll(): void {
    if (this.positionPoll) {
      clearInterval(this.positionPoll);
      this.positionPoll = null;
    }
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
