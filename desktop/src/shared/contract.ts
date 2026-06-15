// Contract shared between the Electron main process and the preload bridge.
//
// The method surface mirrors the mobile `NativePlayer` Capacitor plugin so the
// Angular-side `DesktopEngine` stays a near-copy of `native-engine.ts`.

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
  subtitles?: { url: string; language: string; label: string; forced?: boolean }[];
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

export type DesktopPlayerState = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface DesktopPositionInfo {
  position: number;
  duration: number;
  buffered: number;
}

/** main → renderer event envelope, sent on the single IPC.event channel. */
export type DesktopEvent =
  | { type: 'ready' }
  | { type: 'stateChanged'; payload: { state: DesktopPlayerState } }
  | { type: 'timeUpdate'; payload: DesktopPositionInfo }
  | {
      type: 'tracksChanged';
      payload: { audioTracks: DesktopAudioTrack[]; subtitleTracks: DesktopSubtitleTrack[] };
    }
  | { type: 'firstFrame' }
  | { type: 'error'; payload: { code: number; message: string } };

/** renderer → main invoke channels. */
export const IPC = {
  load: 'player:load',
  play: 'player:play',
  pause: 'player:pause',
  seek: 'player:seek',
  stop: 'player:stop',
  setPlaybackRate: 'player:setPlaybackRate',
  setVolume: 'player:setVolume',
  setMuted: 'player:setMuted',
  setFullscreen: 'player:setFullscreen',
  getPosition: 'player:getPosition',
  getAudioTracks: 'player:getAudioTracks',
  selectAudioTrack: 'player:selectAudioTrack',
  getSubtitleTracks: 'player:getSubtitleTracks',
  selectSubtitleTrack: 'player:selectSubtitleTrack',
  subAdd: 'player:subAdd',
  setSubtitleStyle: 'player:setSubtitleStyle',
  resize: 'player:resize',
  destroy: 'player:destroy',
  /** main → renderer (one channel, discriminated by DesktopEvent.type). */
  event: 'player:event',
} as const;

/** The surface exposed on `window.fliksDesktop` by the preload bridge. */
export interface FliksDesktopApi {
  runtime: 'electron';
  load(opts: DesktopLoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  stop(): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  /** 0..100 (mpv volume scale). */
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
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
  destroy(): Promise<void>;
  on(handler: (event: DesktopEvent) => void): () => void;
}
