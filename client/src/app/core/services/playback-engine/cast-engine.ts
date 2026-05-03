import type {
  PlaybackEngine,
  AudioTrack,
  EngineStats,
  EngineEvent,
  EngineEventMap,
} from './playback-engine';

/**
 * PlaybackEngine implementation backed by CastService + CastPlayerService.
 *
 * This is a plain class (not an Angular service) — the two Cast services
 * are passed in via the constructor when the player switches to Cast mode.
 *
 * Since Cast doesn't expose a rich event model like Shaka or ExoPlayer,
 * we poll the CastService signals every second to emit engine events.
 */
export class CastEngine implements PlaybackEngine {
  private _volume = 1;
  private _muted = false;
  private _playbackRate = 1;

  private handlers = new Map<string, Set<Function>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private castService: any, // CastService
    private castPlayerService: any, // CastPlayerService
  ) {}

  // ── Lifecycle ──

  async init(_container: HTMLElement): Promise<void> {
    // No-op — Cast is already connected when CastEngine is created.
    this.startPoll();
  }

  async destroy(): Promise<void> {
    this.stopPoll();
    this.castService.disconnect();
  }

  // ── Loading ──

  async load(
    _url: string,
    startTime?: number,
    _mimeType?: string,
    _headers?: Record<string, string>,
  ): Promise<void> {
    // The URL is built internally by CastPlayerService — we just forward the start time.
    await this.castPlayerService.reloadCastStream(startTime);
  }

  async unload(): Promise<void> {
    this.castService.stop();
  }

  // ── Playback ──

  async play(): Promise<void> {
    this.castService.play();
  }

  async pause(): Promise<void> {
    this.castService.pause();
  }

  async seek(position: number): Promise<void> {
    this.castService.seek(position);
  }

  // ── State ──

  get currentTime(): number {
    return this.castService.currentTime();
  }

  get duration(): number {
    return this.castService.duration();
  }

  get paused(): boolean {
    return this.castService.isPaused();
  }

  get buffered(): number {
    // Cast doesn't expose buffer information — use currentTime as fallback.
    return this.castService.currentTime();
  }

  get playbackRate(): number {
    return this._playbackRate;
  }

  set playbackRate(rate: number) {
    this._playbackRate = rate;
  }

  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = v; }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) { this._muted = m; }

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    // Cast handles audio track selection internally.
    return [];
  }

  async selectAudioTrack(_id: string): Promise<void> {
    // No-op — Cast handles audio internally.
  }

  // ── Subtitles ──

  async addTextTrack(
    _url: string,
    _language: string,
    _label: string,
  ): Promise<string> {
    // No-op — Cast handles subtitles via loadMedia options.
    return '';
  }

  selectTextTrack(_track: any): void {
    // No-op — Cast handles subtitle selection internally.
  }

  setTextVisibility(_visible: boolean): void {
    // No-op — Cast handles subtitle visibility internally.
  }

  // ── Quality (variant tracks) ──

  getVariantTracks(): any[] {
    return [];
  }

  selectVariantTrack(_track: any, _clearBuffer?: boolean): void {
    // No-op — Cast quality is managed by CastPlayerService.
  }

  configure(_config: any): void {
    // No-op — no Shaka config for Cast engine.
  }

  // ── Stats ──

  getStats(): EngineStats {
    return { droppedFrames: 0 };
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

  // ── Polling ──

  private lastPaused: boolean | null = null;

  private startPoll(): void {
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      const time = this.castService.currentTime();
      const dur = this.castService.duration();
      const paused = this.castService.isPaused();

      this.emit('timeUpdate', {
        position: time,
        duration: dur,
        buffered: time,
      });

      if (this.lastPaused !== paused) {
        this.lastPaused = paused;
        this.emit('stateChanged', {
          state: paused ? 'paused' : 'playing',
        });
      }
    }, 1000);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
