// Bridge to the Electron desktop shell's embedded mpv player, exposed on
// `window.fliksDesktop` by the desktop preload. The Angular DesktopEngine
// consumes this exactly as NativeEngine consumes the NativePlayer Capacitor
// plugin. Types mirror desktop/src/shared/contract.ts — the two live in
// separate build workspaces, so the shape is intentionally duplicated here.

export interface DesktopAudioTrack {
  id: string;
  language: string;
  label: string;
  selected: boolean;
}

export interface DesktopSubtitleTrack {
  id: string;
  language: string;
  label: string;
  forced: boolean;
  selected: boolean;
}

export interface DesktopLoadOptions {
  url: string;
  startTime?: number;
  headers?: Record<string, string>;
  /** Preferred audio language (mpv `alang`) so the player keeps the chosen
   *  language across seeks/reloads instead of reverting to the manifest default. */
  audioLanguage?: string;
}

export interface DesktopSubtitleStyle {
  fontScale: number;
  foregroundColor: string;
  backgroundColor: string;
  edgeType?: string;
  bottomMarginPercent: number;
}

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPositionInfo {
  position: number;
  duration: number;
  buffered: number;
}

/** Native host identity. `systemName` = OS name+version ("macOS 26");
 *  `deviceName` = the user-assigned computer name ("MacBook de Clément"). */
export interface DesktopSystemInfo {
  systemName: string;
  deviceName: string;
}

export type DesktopPlayerState = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export type DesktopEvent =
  | { type: 'ready' }
  | { type: 'stateChanged'; payload: { state: DesktopPlayerState } }
  | { type: 'timeUpdate'; payload: DesktopPositionInfo }
  | {
      type: 'tracksChanged';
      payload: { audioTracks: DesktopAudioTrack[]; subtitleTracks: DesktopSubtitleTrack[] };
    }
  | { type: 'firstFrame' }
  | { type: 'error'; payload: { code: number; message: string; detail?: string } };

export interface FliksDesktopApi {
  runtime: 'electron';
  load(opts: DesktopLoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  stop(): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  getPosition(): Promise<DesktopPositionInfo>;
  getAudioTracks(): Promise<DesktopAudioTrack[]>;
  selectAudioTrack(id: string): Promise<void>;
  getSubtitleTracks(): Promise<DesktopSubtitleTrack[]>;
  selectSubtitleTrack(id: string | null): Promise<void>;
  /** Load a sidecar subtitle file (mpv `sub-add`). Idempotent per URL: mpv
   *  reuses an already-loaded track for the same URL instead of duplicating. */
  subAdd(url: string, label: string, language: string): Promise<void>;
  setSubtitleStyle(style: DesktopSubtitleStyle): Promise<void>;
  resize(rect: DesktopRect): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
  destroy(): Promise<void>;
  /** Native host OS identity (e.g. { systemName: "macOS 26" }). */
  getSystemInfo(): Promise<DesktopSystemInfo>;
  on(handler: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window {
    fliksDesktop?: FliksDesktopApi;
  }
}

/** The desktop bridge, or null when not running in the Electron shell. */
export function desktopBridgeOrNull(): FliksDesktopApi | null {
  return typeof window !== 'undefined' ? (window.fliksDesktop ?? null) : null;
}

/** The desktop bridge; throws when not running in the Electron shell. */
export function desktopBridge(): FliksDesktopApi {
  const api = desktopBridgeOrNull();
  if (!api) throw new Error('fliksDesktop bridge unavailable (not in Electron shell)');
  return api;
}
