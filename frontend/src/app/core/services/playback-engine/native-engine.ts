import { NativePlayer } from '../../plugins/native-player.plugin';
import type {
  PlaybackEngine,
  AudioTrack,
  PlaybackState,
  EngineEvent,
  EngineEventMap,
} from './playback-engine';

/**
 * PlaybackEngine implementation backed by the NativePlayer Capacitor plugin
 * (ExoPlayer on Android, AVPlayer on iOS).
 *
 * The native player renders behind the WebView — the Angular UI sits on top.
 */
export class NativeEngine implements PlaybackEngine {
  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _state: PlaybackState = 'idle';
  private _audioTracks: AudioTrack[] = [];
  private _variantTracks: any[] = [];

  private handlers = new Map<string, Set<Function>>();
  private listeners: Array<{ event: string; fn: EventListener }> = [];
  private positionPoll: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──

  async init(_container: HTMLElement): Promise<void> {
    // Pass 0,0 with -1,-1 (MATCH_PARENT) to fill the entire screen.
    // The native SurfaceView sits behind the transparent WebView.
    await NativePlayer.create({ x: 0, y: 0, width: -1, height: -1 });
    this.bindWindowEvents();
  }

  async destroy(): Promise<void> {
    this.stopPositionPoll();
    this.unbindWindowEvents();
    await NativePlayer.destroy();
  }

  // ── Loading ──

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    await NativePlayer.load({ url, startTime, headers });
    this.startPositionPoll();
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

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    await NativePlayer.selectAudioTrack({ id });
  }

  // ── Subtitles ──

  async addTextTrack(
    url: string,
    language: string,
    label: string,
  ): Promise<string> {
    const result = await NativePlayer.addExternalSubtitle({
      url,
      language,
      label,
    });
    return result.id;
  }

  async selectTextTrack(id: string | null): Promise<void> {
    await NativePlayer.selectSubtitleTrack({ id });
  }

  // ── Quality (variant tracks) ──
  // Native player handles adaptive quality internally.
  // These are thin stubs to satisfy the interface.

  getVariantTracks(): any[] {
    return this._variantTracks;
  }

  selectVariantTrack(_track: any, _clearBuffer?: boolean): void {
    // Native ABR handles this — no-op for now.
    // Could be extended to set max resolution constraints.
  }

  configure(_config: any): void {
    // No Shaka config for native engine
  }

  // ── Events ──

  on<E extends EngineEvent>(
    event: E,
    handler: (data: EngineEventMap[E]) => void,
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<E extends EngineEvent>(
    event: E,
    handler: (data: EngineEventMap[E]) => void,
  ): void {
    this.handlers.get(event)?.delete(handler);
  }

  private emit<E extends EngineEvent>(
    event: E,
    data: EngineEventMap[E],
  ): void {
    this.handlers.get(event)?.forEach((fn) => fn(data));
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
}
