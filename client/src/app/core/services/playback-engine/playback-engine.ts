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
  selected?: boolean;
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
  // `errorKey` is an i18n key the engine resolves the user-facing message
  // from (raw `message` stays for the console). Engines that surface
  // platform-specific strings (Tizen AVPlay, webOS MediaError) set it so the
  // overlay shows translated text instead of an untranslated native string.
  // The optional diagnostic fields (`source`/`category`/`severity`/`data`/
  // `variant`) let Shaka/media errors carry their full context to the error
  // card — the raw Shaka `error.data[]`, the failing variant codec, etc.
  error: {
    code: number;
    message: string;
    errorKey?: string;
    source?: 'shaka' | 'media' | 'session' | 'engine';
    category?: number;
    severity?: number;
    data?: unknown[];
    variant?: string;
  };
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

  /** Whether `firstFrame` has been emitted for the current load. Subclasses
   *  drive the emit via {@link emitFirstFrameOnce} and clear it in load() via
   *  {@link resetFirstFrame}; the recovery heuristic reads it so a pre-frame
   *  failure goes straight to a fatal error instead of optimistic recovery. */
  protected firstFrameEmitted = false;

  /** One-shot guard for the optimistic session-expired recovery. The native /
   *  desktop / TV engines can't read the HTTP status of a failed segment fetch,
   *  so the first error during stable playback is routed to `sessionExpired`
   *  (which makes the player mint a fresh sid + reload). A second error before
   *  the guard is re-armed falls through to a fatal `error`, so a reload that
   *  immediately re-fails can't loop forever. Re-armed only by
   *  {@link resetRecoveryGuard} — never on every load() — so a recovery reload
   *  doesn't reset its own budget. Shaka reads a real 410 instead and never
   *  touches this. */
  protected recoveryAttempted = false;

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

  /** Re-arm the optimistic-recovery one-shot. Called by the player on a
   *  user-initiated (re)load and after a recovery sustains playback. No-op in
   *  effect for engines that read a real HTTP status (Shaka). */
  resetRecoveryGuard(): void {
    this.recoveryAttempted = false;
  }

  /** Clear the first-frame latch at the start of a load() so the next stream
   *  re-emits `firstFrame`. */
  protected resetFirstFrame(): void {
    this.firstFrameEmitted = false;
  }

  /** Emit `firstFrame` exactly once per load. Subclasses call this from
   *  whichever signal first proves a frame was presented (rvfc, position
   *  delta, native first-frame callback). */
  protected emitFirstFrameOnce(): void {
    if (this.firstFrameEmitted) return;
    this.firstFrameEmitted = true;
    this.emit('firstFrame', undefined);
  }

  /** Route a post-first-frame stream error to a single optimistic
   *  `sessionExpired` recovery. Returns true when it consumed the error (the
   *  caller should stop and not surface a fatal error), false when the guard
   *  is spent / no frame has played and the caller must fall through to a real
   *  error. Engines with a platform-specific precondition (e.g. a
   *  network-shaped error string) gate on it before calling this. */
  protected maybeEmitSessionExpired(): boolean {
    if (this.firstFrameEmitted && !this.recoveryAttempted) {
      this.recoveryAttempted = true;
      this.emit('sessionExpired', undefined);
      return true;
    }
    return false;
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
  /** Re-arm the native optimistic-recovery one-shot guard. No-op on engines
   *  that read a real HTTP status (Shaka). Called on a user-initiated
   *  (re)load and after a recovery sustains playback. Provided by
   *  {@link AbstractPlaybackEngine}. */
  resetRecoveryGuard(): void;

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
  // Subtitles are HLS SUBTITLES renditions in the master playlist; each
  // engine maps a chosen track to its player's own track by (language,
  // forced) and returns a handle for `selectTextTrack`. `forced`
  // disambiguates a full vs forced track of the same language.
  addTextTrack(url: string, language: string, label: string, forced?: boolean): Promise<any>;
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
