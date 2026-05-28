/**
 * Unified playback engine interface.
 * Implementations: ShakaEngine (web) and NativeEngine (Android/iOS).
 * Cast bypasses this abstraction — CastPlayerService talks to the
 * Chromecast SDK directly because the receiver-side API doesn't fit
 * the Shaka/ExoPlayer event shape.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioTrack {
  id: string;
  language: string;
  label: string;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  url: string;
  language: string;
  burnIn: boolean;
  subtitleDbId?: number;
  forced?: boolean;
}

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface EngineStats {
  droppedFrames: number;
  streamBandwidth?: number;
  activeVariant?: {
    width?: number;
    height?: number;
    videoBandwidth?: number;
    audioBandwidth?: number;
    videoCodec?: string;
    audioCodec?: string;
  };
}

export type EngineEventMap = {
  stateChanged: { state: PlaybackState };
  timeUpdate: { position: number; duration: number; buffered: number };
  error: { code: number; message: string };
  audioTracksChanged: { tracks: AudioTrack[] };
  ended: void;
  /** Fires when the first video frame is presented to the screen.
   *  Distinct from `stateChanged: 'playing'` which fires on play() (the
   *  user-facing first frame is what matters for the loading veil). */
  firstFrame: void;
  /** Backend returned 410 Gone with `code: 'session_expired'` on a
   *  segment / playlist request — the LiveSession registered at
   *  /playback-info is gone (typical after a backend restart or a
   *  long-idle GC). The player should mint a fresh sid via a new
   *  /playback-info call and reload the engine. Shaka detects this via
   *  a NetworkingEngine response filter; native players (AVPlay / iOS /
   *  Android) can't read the response body so they translate any
   *  segment-level HTTP error during stable playback into this event
   *  and the player tries one cheap recovery before surfacing a fatal
   *  error to the UI. */
  sessionExpired: void;
};

export type EngineEvent = keyof EngineEventMap;

export type EngineEventHandler<E extends EngineEvent> = (
  data: EngineEventMap[E],
) => void;

// ---------------------------------------------------------------------------
// Base class — shared event bus
// ---------------------------------------------------------------------------

/** Common event-bus plumbing for every PlaybackEngine. Subclasses
 *  inherit on/off and call `this.emit(event, data)` from their own
 *  bridge code (video element listeners, Capacitor window events, Cast
 *  polling). Keeps the typed handler map identical across engines so
 *  divergence on event semantics can't sneak in by accident. */
export abstract class AbstractPlaybackEngine {
  private handlers = new Map<EngineEvent, Set<EngineEventHandler<any>>>();

  on<E extends EngineEvent>(event: E, handler: EngineEventHandler<E>): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<E extends EngineEvent>(event: E, handler: EngineEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  protected emit<E extends EngineEvent>(
    event: E,
    data: EngineEventMap[E],
  ): void {
    const set = this.handlers.get(event);
    if (set) for (const h of set) h(data);
  }

  protected clearHandlers(): void {
    this.handlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PlaybackEngine {
  // ── Lifecycle ──
  init(container: HTMLElement): Promise<void>;
  destroy(): Promise<void>;
  load(url: string, startTime?: number, mimeType?: string, headers?: Record<string, string>): Promise<void>;
  unload(): Promise<void>;

  // ── Playback ──
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;

  // ── State (sync getters) ──
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly buffered: number;
  playbackRate: number;
  volume: number;
  muted: boolean;

  // ── Audio tracks ──
  getAudioTracks(): AudioTrack[];
  selectAudioTrack(id: string): Promise<void>;

  // ── Subtitles ──
  addTextTrack(url: string, language: string, label: string): Promise<any>;
  selectTextTrack(track: any): void;
  setTextVisibility(visible: boolean): void;

  // ── Quality (Shaka variant tracks) ──
  getVariantTracks(): any[];
  selectVariantTrack(track: any, clearBuffer?: boolean): void;
  configure(config: any): void;

  // ── Stats ──
  getStats(): EngineStats;

  // ── Events ──
  on<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
  off<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
}
