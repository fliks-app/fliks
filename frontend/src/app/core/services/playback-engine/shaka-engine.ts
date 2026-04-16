import shaka from 'shaka-player';
import {
  AudioTrack,
  EngineEvent,
  EngineEventMap,
  EngineStats,
  PlaybackEngine,
  PlaybackState,
} from './playback-engine';

type Handler<E extends EngineEvent> = (data: EngineEventMap[E]) => void;

/**
 * Shaka Player implementation of the PlaybackEngine interface.
 *
 * Wraps shaka.Player and the underlying HTMLVideoElement into the unified
 * engine API so player.ts doesn't interact with Shaka directly.
 *
 * This is a plain TypeScript class with NO Angular dependencies.
 */
export class ShakaEngine implements PlaybackEngine {

  private player: shaka.Player | null = null;
  private video: HTMLVideoElement | null = null;

  /** Per-event listener maps for the unified event system. */
  private listeners = new Map<EngineEvent, Set<Handler<any>>>();

  /** Refs kept so we can removeEventListener on destroy. */
  private videoListeners: Array<{ event: string; handler: EventListener }> = [];
  private shakaListeners: Array<{ event: string; handler: EventListener }> = [];

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async init(container: HTMLElement): Promise<void> {
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      throw new Error('Shaka Player: browser not supported');
    }

    const video = container as HTMLVideoElement;
    this.video = video;

    this.player = new shaka.Player();
    await this.player.attach(video);

    // Sensible streaming defaults
    this.player.configure({
      streaming: {
        bufferingGoal: 60,
        rebufferingGoal: 1,
        bufferBehind: 60,
      },
    } as any);

    this.bridgeVideoEvents();
    this.bridgeShakaEvents();
  }

  async destroy(): Promise<void> {
    // Remove video element listeners
    if (this.video) {
      for (const { event, handler } of this.videoListeners) {
        this.video.removeEventListener(event, handler);
      }
    }
    this.videoListeners = [];

    // Remove Shaka event listeners
    if (this.player) {
      for (const { event, handler } of this.shakaListeners) {
        this.player.removeEventListener(event, handler);
      }
    }
    this.shakaListeners = [];

    // Tear down Shaka
    if (this.player) {
      await this.player.destroy();
      this.player = null;
    }

    this.video = null;
    this.listeners.clear();
  }

  async load(url: string, startTime?: number, mimeType?: string, _headers?: Record<string, string>): Promise<void> {
    if (!this.player) throw new Error('ShakaEngine not initialised');
    await this.player.load(url, startTime, mimeType);
  }

  async unload(): Promise<void> {
    if (this.player) {
      await this.player.unload();
    }
  }

  // ─── Playback ──────────────────────────────────────────────────────

  async play(): Promise<void> {
    await this.video?.play();
  }

  async pause(): Promise<void> {
    this.video?.pause();
  }

  async seek(position: number): Promise<void> {
    if (this.video) {
      this.video.currentTime = position;
    }
  }

  // ─── State (sync getters / setters) ────────────────────────────────

  get currentTime(): number {
    return this.video?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.video?.duration ?? 0;
    return isFinite(d) ? d : 0;
  }

  get paused(): boolean {
    return this.video?.paused ?? true;
  }

  get buffered(): number {
    const buf = this.video?.buffered;
    if (!buf || buf.length === 0) return 0;
    return buf.end(buf.length - 1);
  }

  get playbackRate(): number {
    return this.video?.playbackRate ?? 1;
  }
  set playbackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate;
  }

  get volume(): number {
    return this.video?.volume ?? 1;
  }
  set volume(v: number) {
    if (this.video) this.video.volume = v;
  }

  get muted(): boolean {
    return this.video?.muted ?? false;
  }
  set muted(m: boolean) {
    if (this.video) this.video.muted = m;
  }

  // ─── Audio tracks ──────────────────────────────────────────────────

  getAudioTracks(): AudioTrack[] {
    if (!this.player) return [];

    const variants = this.player.getVariantTracks();

    // Deduplicate by audioId (each audio track appears in multiple variants
    // for different video qualities).
    const seen = new Map<number, any>();
    for (const v of variants) {
      if (v.audioId != null && !seen.has(v.audioId)) {
        seen.set(v.audioId, v);
      }
    }

    return Array.from(seen.entries()).map(([audioId, v]) => ({
      id: `shaka-${audioId}`,
      label: `${v.language ?? 'und'} (${v.audioCodec ?? '?'}${v.channelsCount ? ' ' + v.channelsCount + 'ch' : ''})`,
      language: v.language ?? 'und',
    }));
  }

  async selectAudioTrack(id: string): Promise<void> {
    if (!this.player || !id.startsWith('shaka-')) return;

    const audioId = parseInt(id.replace('shaka-', ''), 10);
    const variants = this.player.getVariantTracks();
    const active = variants.find((v: any) => v.active);

    // Prefer a variant that keeps the current videoId (quality) while switching audio.
    const target =
      variants.find((v: any) => v.audioId === audioId && v.videoId === active?.videoId)
      ?? variants.find((v: any) => v.audioId === audioId);

    if (target) {
      this.player.selectVariantTrack(target, /* clearBuffer= */ true);
    }
  }

  // ─── Subtitles ─────────────────────────────────────────────────────

  async addTextTrack(url: string, language: string, label: string): Promise<any> {
    if (!this.player) throw new Error('ShakaEngine not initialised');
    return this.player.addTextTrackAsync(url, language, 'subtitles', 'text/vtt', undefined, label);
  }

  selectTextTrack(track: any): void {
    this.player?.selectTextTrack(track);
  }

  setTextVisibility(visible: boolean): void {
    try {
      (this.player as any)?.setTextVisibility(visible);
    } catch {
      // Shaka may throw if no text tracks exist
    }
  }

  // ─── Quality (variant tracks) ──────────────────────────────────────

  getVariantTracks(): any[] {
    return this.player?.getVariantTracks() ?? [];
  }

  selectVariantTrack(track: any, clearBuffer?: boolean): void {
    this.player?.selectVariantTrack(track, clearBuffer);
  }

  configure(config: any): void {
    this.player?.configure(config);
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  getStats(): EngineStats {
    const shakaStats = this.player?.getStats() as
      | { droppedFrames?: number; streamBandwidth?: number }
      | undefined;

    const activeTrack = this.player?.getVariantTracks()?.find((t: any) => t.active);

    return {
      droppedFrames: shakaStats?.droppedFrames ?? 0,
      streamBandwidth: shakaStats?.streamBandwidth,
      activeVariant: activeTrack
        ? {
            width: activeTrack.width ?? undefined,
            height: activeTrack.height ?? undefined,
            videoBandwidth: activeTrack.videoBandwidth ?? undefined,
            audioBandwidth: (activeTrack as any).audioBandwidth ?? undefined,
            videoCodec: activeTrack.videoCodec ?? undefined,
            audioCodec: activeTrack.audioCodec ?? undefined,
          }
        : undefined,
    };
  }

  // ─── Events ────────────────────────────────────────────────────────

  on<E extends EngineEvent>(event: E, handler: Handler<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off<E extends EngineEvent>(event: E, handler: Handler<E>): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit<E extends EngineEvent>(event: E, data: EngineEventMap[E]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) {
        h(data);
      }
    }
  }

  // ─── Internal: bridge native events ────────────────────────────────

  private addVideoListener(event: string, handler: EventListener): void {
    this.video!.addEventListener(event, handler);
    this.videoListeners.push({ event, handler });
  }

  private addShakaListener(event: string, handler: EventListener): void {
    this.player!.addEventListener(event, handler);
    this.shakaListeners.push({ event, handler });
  }

  private bridgeVideoEvents(): void {
    const video = this.video!;

    // Time updates
    this.addVideoListener('timeupdate', () => {
      const buf = video.buffered;
      const buffered = buf.length > 0 ? buf.end(buf.length - 1) : 0;
      this.emit('timeUpdate', {
        position: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        buffered,
      });
    });

    // Buffered progress
    this.addVideoListener('progress', () => {
      const buf = video.buffered;
      const buffered = buf.length > 0 ? buf.end(buf.length - 1) : 0;
      this.emit('timeUpdate', {
        position: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        buffered,
      });
    });

    // State transitions
    this.addVideoListener('play', () => {
      this.emit('stateChanged', { state: 'playing' });
    });

    this.addVideoListener('pause', () => {
      this.emit('stateChanged', { state: 'paused' });
    });

    this.addVideoListener('waiting', () => {
      this.emit('stateChanged', { state: 'buffering' });
    });

    this.addVideoListener('stalled', () => {
      // Network stall — show buffering if not paused and buffer is nearly empty
      if (!video.paused && video.buffered.length > 0) {
        const bufferedAhead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        if (bufferedAhead < 1) {
          this.emit('stateChanged', { state: 'buffering' });
        }
      }
    });

    this.addVideoListener('playing', () => {
      this.emit('stateChanged', { state: 'playing' });
    });

    this.addVideoListener('canplay', () => {
      // Resolve buffering state when enough data is available
      if (!video.paused) {
        this.emit('stateChanged', { state: 'playing' });
      }
    });

    this.addVideoListener('ended', () => {
      this.emit('stateChanged', { state: 'ended' });
      this.emit('ended', undefined as any);
    });

    // Video element errors
    this.addVideoListener('error', () => {
      const e = video.error;
      console.error('[Shaka] Video element error:', e?.code, e?.message);
      this.emit('error', {
        code: e?.code ?? 0,
        message: e?.message ?? `Video error code ${e?.code}`,
      });
      this.emit('stateChanged', { state: 'error' });
    });
  }

  private bridgeShakaEvents(): void {
    // Shaka error events (separate from HTMLVideoElement errors)
    this.addShakaListener('error', (e: any) => {
      const detail = e.detail;
      console.error('[Shaka] Player error:', detail?.code, detail?.category, detail?.message, detail?.data);
      this.emit('error', {
        code: detail?.code ?? 0,
        message: detail?.message ?? 'Shaka playback error',
      });
      this.emit('stateChanged', { state: 'error' });
    });
  }
}
