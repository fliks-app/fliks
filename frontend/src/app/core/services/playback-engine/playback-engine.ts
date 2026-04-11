/**
 * Unified playback engine interface.
 * Two implementations: ShakaEngine (web) and NativeEngine (Android/iOS).
 *
 * The engine abstracts the video player so the UI (player.ts) doesn't need
 * to know whether Shaka Player or ExoPlayer/AVPlayer is doing the actual work.
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
  language: string;
  label: string;
  url: string;
  /** True for bitmap subs (PGS/VOBSUB) that need server-side burn-in */
  burnIn: boolean;
  /** Database subtitle ID (for burn-in request) */
  subtitleDbId?: number;
  forced?: boolean;
}

export interface QualityLevel {
  id: string;
  label: string;
  height: number;
}

export type PlaybackState =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error';

export type EngineEventMap = {
  stateChanged: { state: PlaybackState };
  timeUpdate: { position: number; duration: number; buffered: number };
  error: { code: number; message: string };
  audioTracksChanged: { tracks: AudioTrack[] };
  subtitleTracksChanged: { tracks: SubtitleTrack[] };
};

export type EngineEvent = keyof EngineEventMap;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PlaybackEngine {
  // ── Lifecycle ──
  init(container: HTMLElement): Promise<void>;
  destroy(): Promise<void>;

  // ── Loading ──
  load(
    url: string,
    startTime?: number,
    mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void>;
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

  // ── Audio tracks ──
  getAudioTracks(): AudioTrack[];
  selectAudioTrack(id: string): Promise<void>;

  // ── Subtitles ──
  addTextTrack(url: string, language: string, label: string): Promise<string>;
  selectTextTrack(id: string | null): Promise<void>;

  // ── Quality (video variants) ──
  getVariantTracks(): any[];
  selectVariantTrack(track: any, clearBuffer?: boolean): void;
  configure(config: any): void;

  // ── Events ──
  on<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
  off<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
}
