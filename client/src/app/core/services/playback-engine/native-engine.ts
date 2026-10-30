import { Capacitor } from '@capacitor/core';
import { NativePlayer, type NativePlayerCrop, type NativeSidecarSubtitle } from '../../plugins/native-player.plugin';
import {
  AbstractPlaybackEngine,
  pausedFlagForState,
  type PlaybackEngine,
  type AudioTrack,
  type EngineQoeSample,
  type EngineStats,
  type EngineState,
  type EngineConfig,
  type TextTrackHandle,
  type TextTrackPick,
  type VariantSize,
} from './playback-engine';
import {
  toNativeSubtitleStyle,
  type NativeSubtitleStyle,
  type SubtitleStyleSettings,
} from '../../utils/subtitle-presets';
import { normalizeLangCode } from '../../utils/language.utils';
import type { TimeRange } from '../../utils/edl-policy';

/** PlaybackEngine backed by the NativePlayer Capacitor plugin (ExoPlayer/AVPlayer), rendering behind the WebView. */
export class NativeEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  readonly positionUpdateMs = 1_000;
  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _state: EngineState = 'idle';
  private _audioTracks: AudioTrack[] = [];

  private listeners: Array<{ event: string; fn: EventListener }> = [];

  /** Android's onRenderedFirstFrame fires late or never on some devices; a growing position emits 'firstFrame' ourselves. */
  private lastTimeUpdatePos = -1;

  // ── Subtitles ──
  // Native HLS SUBTITLES renditions render in the player's own pipeline, so they show in PiP/AirPlay with no app overlay.
  /** Player's own id ("text-N") of the currently selected track. */
  private _activeTrackId: string | null = null;
  /** Desired subtitle, held because the default is applied right after load() before ExoPlayer parses text tracks; re-applied on `nativePlayerTracksChanged`. */
  private _desiredSubtitle: {
    language: string;
    forced: boolean;
    image: boolean;
    index: number;
  } | null = null;
  /** Text tracks the player currently reports, refreshed on track changes. */
  private _nativeSubtitleTracks: {
    id: string;
    language: string;
    label: string;
    forced?: boolean;
    image?: boolean;
  }[] = [];

  // ── Lifecycle ──

  private _initialized = false;

  async init(container: HTMLElement): Promise<void> {
    // Pass 0,0 with -1,-1 (MATCH_PARENT) to fill the entire screen.
    // The native SurfaceView sits behind the transparent WebView.
    await NativePlayer.create({ x: 0, y: 0, width: -1, height: -1 });
    this._initialized = true;
    this.bindWindowEvents();
    this.followContainer(container);
    if (this._subtitleStyle) {
      NativePlayer.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    this._initialized = false;
    this.unbindWindowEvents();
    this.viewportObserver?.disconnect();
    this.viewportObserver = null;
    this._activeTrackId = null;
    this._crop = null;
    // Without this each navigation leaks listeners onto the long-lived NativePlayer bridge.
    this.clearHandlers();
    await NativePlayer.destroy();
  }

  // ── Loading ──

  startPaused = false;
  keepFrame = false;
  private _offline = false;

  /** Mark next load() as offline — uses CacheDataSource on Android. */
  setOffline(offline: boolean) { this._offline = offline; }

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    this.resetFirstFrame();
    const startPaused = this.startPaused;
    this.startPaused = false;
    const keepFrame = this.keepFrame;
    this.keepFrame = false;
    this.lastTimeUpdatePos = -1;
    // Fresh media → fresh tracks: the previous item's list must not outlive it.
    this._audioTracks = [];
    // Android picks its audio sink at load time from the ranges, so they go first.
    await this.pushMuteRanges(true);
    const info = this.mediaInfo?.();
    // The sidecars of this load, set by the player beforehand (empty for
    // transcode/remux, which carry subs as HLS renditions).
    await NativePlayer.load({
      url,
      startTime,
      headers,
      offline: this._offline,
      startPaused,
      keepFrame,
      subtitles: this._preloadedSubtitles,
      backgroundAudio: !!info,
      title: info?.title,
      artist: info?.artist,
      artworkUrl: info?.artworkUrl,
    });

    // Apply subtitle style settings
    if (this._subtitleStyle) {
      await NativePlayer.setSubtitleStyle(this._subtitleStyle);
    }
    if (this._fillScreen) {
      await NativePlayer.setFillScreen({ fill: true }).catch(() => {});
    }
    if (this._crop) {
      await NativePlayer.setCrop(this._crop).catch(() => {});
    }

    // A new MediaItem resurfaces text tracks: drop the stale id; the desired selection re-applies on `nativePlayerTracksChanged`.
    this._activeTrackId = null;
    this._nativeSubtitleTracks = [];
  }

  private _muteRanges: TimeRange[] = [];
  private _sentMuteRanges = '[]';
  private _muteWarned = false;

  setMuteRanges(ranges: readonly TimeRange[]): void {
    this._muteRanges = ranges.map((r) => ({ start: r.start, end: r.end }));
    void this.pushMuteRanges(false);
  }

  private async pushMuteRanges(atLoad: boolean): Promise<void> {
    const key = JSON.stringify(this._muteRanges);
    if (atLoad ? this._muteRanges.length === 0 : key === this._sentMuteRanges) return;
    this._sentMuteRanges = key;
    try {
      await NativePlayer.setMuteRanges({ ranges: this._muteRanges });
    } catch (e) {
      if (!this._muteWarned) console.warn('[native-engine] setMuteRanges unavailable', e);
      this._muteWarned = true;
    }
  }

  private _subtitleStyle: NativeSubtitleStyle | null = null;

  /** Set subtitle appearance. Call before load() or anytime after. */
  setSubtitleStyle(settings: SubtitleStyleSettings): void {
    this._subtitleStyle = toNativeSubtitleStyle(settings);

    if (this._initialized) {
      NativePlayer.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  private _fillScreen = false;

  /** Crop the video to fill the surface instead of letterboxing it. Re-applied
   *  after load() so a surface rebuilt by an error retry keeps the mode. */
  setFillScreen(fill: boolean): void {
    this._fillScreen = fill;
    NativePlayer.setFillScreen({ fill }).catch(() => {});
  }

  /** Set by the player from the device profile: only builds whose plugin
   *  implements `setCrop` may receive it. */
  cropSupported = false;
  /** Set by the player, read on every load: null keeps playback tied to the screen. */
  mediaInfo: (() => { title: string; artist?: string; artworkUrl?: string }) | null = null;
  /** The notification's queue buttons. */
  onNext: (() => void) | null = null;
  onPrevious: (() => void) | null = null;
  onStop: (() => void) | null = null;
  onToggleLike: (() => void) | null = null;
  private _crop: NativePlayerCrop | null = null;

  /** Crop the letterbox bars natively. Kept and re-applied after load(), the
   *  native side drops it with the item. Returns whether the crop is in effect. */
  setCrop(
    rect: { x: number; y: number; width: number; height: number } | null | undefined,
    sourceWidth: number,
    sourceHeight: number,
  ): boolean {
    const crop =
      this.cropSupported && rect?.width && rect.height && sourceWidth && sourceHeight
        ? { ...rect, sourceWidth, sourceHeight }
        : null;
    this._crop = crop;
    if (this.cropSupported) {
      NativePlayer.setCrop(crop ?? {}).catch(() => {});
    }
    return crop !== null;
  }

  private _preloadedSubtitles: NativeSidecarSubtitle[] = [];

  /** Sidecar subtitles for the native MediaItem: read by every load(), so the
   *  caller sets them before each one. */
  setPreloadedSubtitles(subs: NativeSidecarSubtitle[]): void {
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

  /** False when the platform can't retry in place (iOS), so the caller reloads instead. */
  async retry(): Promise<boolean> {
    try {
      await NativePlayer.retry();
    } catch {
      return false;
    }
    this.resetRecoveryGuard();
    return true;
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
  /** The bridge emits `timeUpdate` once per second. */
  readonly positionStepS = 1;
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

  // Volume and muted are local-only: the host OS owns output level, the setters just satisfy the PlaybackEngine contract.
  get volume(): number { return this._volume; }
  readonly supportsVolume = false;
  /** iOS applies `volume` as a multiplier on the player; the party voice ducking is its only writer. */
  readonly supportsDucking = Capacitor.getPlatform() === 'ios';

  set volume(v: number) {
    this._volume = v;
    if (this.supportsDucking) NativePlayer.setVolume({ volume: v }).catch(() => {});
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    await NativePlayer.selectAudioTrack({ id });
  }

  // ── Subtitles ──
  // Preloaded at load(); addTextTrack matches by URL and returns the ExoPlayer text track index.

  private _subtitleUrls: string[] = [];

  /** Store subtitle URLs passed at load() for matching later. */
  setSubtitleUrls(urls: string[]): void {
    this._subtitleUrls = urls;
  }

  async addTextTrack(
    _url: string,
    language: string,
    _label: string,
    forced = false,
    index = 0,
  ): Promise<{ language: string; forced: boolean; index: number }> {
    // Returns only the descriptor; selection resolves against the player's tracks once the manifest is parsed (see resolveSubtitle).
    return { language, forced, index };
  }

  selectTextTrack(handle: TextTrackHandle | null): void {
    const track = handle as TextTrackPick | null;
    this._desiredSubtitle =
      track && typeof track === 'object' && track.language
        ? {
            language: track.language,
            forced: !!track.forced,
            image: !!track.image,
            index: Number(track.index) || 0,
          }
        : null;
    // No list yet means the plugin has none cached: asking again makes it
    // re-read the asset.
    if (this._nativeSubtitleTracks.length === 0) this.refreshSubtitleTracks();
    else this.resolveSubtitle();
  }

  setTextVisibility(visible: boolean): void {
    if (!visible) {
      this._desiredSubtitle = null;
      this._activeTrackId = null;
      NativePlayer.selectSubtitleTrack({ id: null });
    }
  }

  /** No-op until the player surfaces text tracks; the `nativePlayerTracksChanged` handler re-runs it. */
  private resolveSubtitle(): void {
    if (!this._desiredSubtitle) return;
    const { language, forced, image, index } = this._desiredSubtitle;
    const want = normalizeLangCode(language);
    const tracks = this._nativeSubtitleTracks;
    // Match image-ness, then forced, then the ordinal among same (language, image, forced) tracks; fall back to language alone, never another language.
    const sameTagged = tracks.filter(
      (t) =>
        normalizeLangCode(t.language) === want &&
        !!t.image === !!image &&
        !!t.forced === !!forced,
    );
    const id =
      sameTagged[index] ??
      sameTagged[0] ??
      tracks.find(
        (t) => normalizeLangCode(t.language) === want && !!t.image === !!image,
      ) ??
      tracks.find((t) => normalizeLangCode(t.language) === want);
    // An unresolved pick leaves the previous track off rather than on screen.
    const selectedId = id?.id ?? null;
    if (selectedId !== this._activeTrackId) {
      this._activeTrackId = selectedId;
      NativePlayer.selectSubtitleTrack({ id: selectedId });
    }
  }

  /** Queried from the plugin because the Android bridge reports an empty list on the track-change event. */
  private refreshSubtitleTracks(): void {
    NativePlayer.getSubtitleTracks()
      .then(({ tracks }) => {
        this._nativeSubtitleTracks = tracks ?? [];
        this.resolveSubtitle();
      })
      .catch(() => {});
  }

  // ── Stats ──

  getStats(): EngineStats {
    return { droppedFrames: 0 };
  }

  override async getQoeSample(): Promise<EngineQoeSample | null> {
    return NativePlayer.getQoe().catch(() => null);
  }

  // ── Quality ──
  // ExoPlayer handles ABR internally. We control it via max resolution constraints.

  selectVariantTrack(track: VariantSize): void {
    // Set max resolution to the selected track's resolution
    if (track?.height) {
      NativePlayer.setMaxResolution({
        width: track.width ?? track.height * 2,
        height: track.height,
      });
    }
  }

  configure(config: EngineConfig): void {
    // ABR off needs nothing here: a manual pick goes through selectVariantTrack, which pins the variant.
    if (config?.abr?.enabled === true) {
      // Auto mode: remove resolution constraints
      NativePlayer.setMaxResolution({ width: 0, height: 0 });
    }
    const preferredAudioLanguage = config?.preferredAudioLanguage;
    const defaultBandwidthEstimate = config?.abr?.defaultBandwidthEstimate;
    if (preferredAudioLanguage !== undefined || defaultBandwidthEstimate !== undefined) {
      // Builds without the method (and iOS) reject: nothing to apply there.
      NativePlayer.configure({ preferredAudioLanguage, defaultBandwidthEstimate }).catch(() => {});
    }
  }

  /** iOS keeps the heartbeat going natively once the WebView is suspended. */
  setHeartbeat(target: { url: string; token: string; body: Record<string, unknown> }): void {
    if (Capacitor.getPlatform() === 'ios') NativePlayer.setHeartbeat(target).catch(() => {});
  }

  // ── Window event bridge ──

  private viewportObserver: ResizeObserver | null = null;
  private viewport = '';

  /** The native surface sits behind the WebView: it is kept on the container's rectangle, so a layout that
   *  shrinks the player (a side panel) moves the picture with the controls. A full-viewport container sends -1. */
  private followContainer(container: HTMLElement): void {
    const sync = () => {
      const r = container.getBoundingClientRect();
      const full = r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;
      const rect = full
        ? { x: 0, y: 0, width: -1, height: -1 }
        : { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key === this.viewport || !this._initialized) return;
      this.viewport = key;
      NativePlayer.resize(rect).catch(() => {});
    };
    this.viewportObserver = new ResizeObserver(sync);
    this.viewportObserver.observe(container);
    this.viewport = '0,0,-1,-1';
    sync();
  }

  private bindWindowEvents(): void {
    const bind = (eventName: string, fn: EventListener) => {
      window.addEventListener(eventName, fn);
      this.listeners.push({ event: eventName, fn });
    };

    bind('nativePlayerNext', () => this.onNext?.());
    bind('nativePlayerPrevious', () => this.onPrevious?.());
    bind('nativePlayerStop', () => this.onStop?.());
    bind('nativePlayerToggleLike', () => this.onToggleLike?.());

    bind('nativePlayerStateChanged', (e: Event) => {
      const detail = (e as CustomEvent).detail;
      this._state = detail.state;
      const paused = pausedFlagForState(detail.state);
      if (paused !== undefined) this._paused = paused;
      this.emit('stateChanged', { state: detail.state });
      // The bridge reports end-of-stream only via stateChanged; emit 'ended' so the player can advance.
      if (detail.state === 'ended') this.emit('ended', undefined);
    });

    bind('nativePlayerTimeUpdate', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._currentTime = d.position;
      this._duration = d.duration;
      this._buffered = d.buffered;
      this.emit('timeUpdate', d);
      // Native sends timeUpdate only while playing, so growth between two updates means frames flow; the second sample is used since a seek-resume's first can precede any render.
      if (
        !this.firstFrameEmitted &&
        this.lastTimeUpdatePos >= 0 &&
        d.position > this.lastTimeUpdatePos
      ) {
        this.emitFirstFrameOnce();
      }
      this.lastTimeUpdatePos = d.position;
    });

    bind('nativePlayerError', (e: Event) => {
      const d = (e as CustomEvent).detail;
      // The HTTP status of the failed segment is hidden (410 vs 5xx): after a played frame, treat the first error as possible session expiry and try one reload.
      if (this.maybeEmitSessionExpired({ source: 'native', code: d.code })) return;
      this._state = 'error';
      this.emit('error', { ...d, source: 'native' });
    });

    bind('nativePlayerTracksChanged', (e: Event) => {
      const d = (e as CustomEvent).detail;
      this._audioTracks = d.audioTracks ?? [];
      this.emit('audioTracksChanged', { tracks: this._audioTracks });
      // Text tracks are now available — refresh them and apply any pending
      // (default / saved) subtitle selection that raced ahead of load().
      this.refreshSubtitleTracks();
    });

    bind('nativePlayerExternalPlaybackFailed', (e: Event) => {
      this.emit('externalPlaybackFailed', { reason: (e as CustomEvent).detail?.reason ?? '' });
    });

    bind('nativePlayerFirstFrame', () => {
      this.emitFirstFrameOnce();
    });
  }

  private unbindWindowEvents(): void {
    for (const { event, fn } of this.listeners) {
      window.removeEventListener(event, fn);
    }
    this.listeners = [];
  }
}
