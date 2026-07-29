import { registerPlugin } from '@capacitor/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeAudioTrack {
  id: string;
  language: string;
  label: string;
  /** True for the currently active audio track, so the menu highlights it. */
  selected?: boolean;
}

export interface NativeSubtitleTrack {
  id: string;
  language: string;
  label: string;
  /** True if the track carries only forced (foreign-dialogue) cues. */
  forced?: boolean;
  /** True for bitmap (PGS/VOBSUB/DVB) tracks ExoPlayer renders as images. */
  image?: boolean;
}

export interface NativePlayerPosition {
  /** Current playback position in seconds */
  position: number;
  /** Total duration in seconds */
  duration: number;
  /** Buffered position in seconds */
  buffered: number;
}

export type NativePlayerState =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error';

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface NativePlayerPlugin {
  // ── Lifecycle ──

  /** Create the native player surface behind the WebView. */
  create(options: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;

  /** Destroy the native player and release resources. */
  destroy(): Promise<void>;

  /** Resize the native player surface (e.g. on orientation change). */
  resize(options: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;

  // ── Playback ──

  /** Load an HLS stream. Headers are used for auth (Bearer token). */
  load(options: {
    url: string;
    startTime?: number;
    headers?: Record<string, string>;
    subtitles?: { url: string; language: string; label: string }[];
    /** Use CacheDataSource for offline playback (Android). */
    offline?: boolean;
  }): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  stop(): Promise<void>;

  // ── Tracks ──

  getAudioTracks(): Promise<{ tracks: NativeAudioTrack[] }>;
  selectAudioTrack(options: { id: string }): Promise<void>;

  getSubtitleTracks(): Promise<{ tracks: NativeSubtitleTrack[] }>;
  selectSubtitleTrack(options: { id: string | null }): Promise<void>;

  // ── Subtitle style ──

  /** Apply subtitle appearance settings to the native SubtitleView. */
  setSubtitleStyle(options: {
    fontScale: number;       // 0.7, 0.9, 1.2, 1.5
    foregroundColor: string; // hex #RRGGBB
    backgroundColor: string; // hex #AARRGGBB or 'transparent'
    edgeType: string;        // 'none' | 'drop_shadow' | 'outline' | 'raised'
    bottomMarginPercent: number;
  }): Promise<void>;

  // ── Display ──

  /** Crop the video to fill the surface (`true`) or letterbox it (`false`).
   *  The engines render outside the <video> element, so the CSS object-fit
   *  binding the browser path uses can't reach them. */
  setFillScreen(options: { fill: boolean }): Promise<void>;

  // ── Brightness ──

  /** Set screen brightness. -1 = restore system default, 1.0 = max. */
  setBrightness(options: { brightness: number }): Promise<void>;

  // ── Quality ──

  /** Set max video resolution constraint. Pass 0,0 for auto (no restriction). */
  setMaxResolution(options: { width: number; height: number }): Promise<void>;

  // ── State ──

  getPosition(): Promise<NativePlayerPosition>;
  setPlaybackRate(options: { rate: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Event types (dispatched as CustomEvent on window)
// ---------------------------------------------------------------------------

/** window event: 'nativePlayerStateChanged' */
export interface NativePlayerStateEvent {
  state: NativePlayerState;
}

/** window event: 'nativePlayerTimeUpdate' */
export interface NativePlayerTimeEvent {
  position: number;
  duration: number;
  buffered: number;
}

/** window event: 'nativePlayerError' */
export interface NativePlayerErrorEvent {
  code: number;
  message: string;
}

/** window event: 'nativePlayerTracksChanged' */
export interface NativePlayerTracksEvent {
  audioTracks: NativeAudioTrack[];
  subtitleTracks: NativeSubtitleTrack[];
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const NativePlayer =
  registerPlugin<NativePlayerPlugin>('NativePlayer');
