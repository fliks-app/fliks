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

/** Host identity resolved natively in the main process (the browser UA can't
 *  give a real OS version nor the machine name). `systemName` is a human OS
 *  string like "macOS 26" / "Ubuntu 24.04"; `deviceName` is the user-assigned
 *  computer name like "MacBook de Clément". */
export interface DesktopSystemInfo {
  systemName: string;
  deviceName: string;
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
  /** Host OS identity (name + version), resolved natively. */
  getSystemInfo: 'system:info',
  /** main → renderer (one channel, discriminated by DesktopEvent.type). */
  event: 'player:event',
} as const;

/** Info about an available app update (from electron-updater, or the GitHub
 *  release on the .deb fallback path). */
export interface DesktopUpdateInfo {
  version: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  releaseUrl: string | null;
}

/** main → renderer update lifecycle, sent on the UPDATE_IPC.status channel. */
export type DesktopUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: DesktopUpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; info: DesktopUpdateInfo }
  | { state: 'error'; message: string };

/** What the renderer needs to render the right action button. `canInstall`
 *  is false on builds electron-updater can't self-install (Linux .deb, dev
 *  runs) — there the UI offers a download link to `releasesUrl` instead. */
export interface DesktopUpdateCapability {
  canInstall: boolean;
  currentVersion: string;
  releasesUrl: string;
}

/** renderer → main update channels + the single main → renderer status channel. */
export const UPDATE_IPC = {
  check: 'update:check',
  install: 'update:install',
  openReleases: 'update:openReleases',
  getCapability: 'update:getCapability',
  /** main → renderer (discriminated by DesktopUpdateStatus.state). */
  status: 'update:status',
} as const;

/** The surface exposed on `window.fliksUpdater` by the preload bridge. */
export interface FliksUpdaterApi {
  /** Capability + current version, resolved natively. */
  getCapability(): Promise<DesktopUpdateCapability>;
  /** Trigger a check now; results arrive via the status channel. */
  check(): Promise<void>;
  /** Download (if needed) and install + relaunch. No-op when !canInstall. */
  install(): Promise<void>;
  /** Open the GitHub releases page (the .deb / dev fallback). */
  openReleases(): Promise<void>;
  onStatus(handler: (status: DesktopUpdateStatus) => void): () => void;
}

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
  /** Native host OS identity (e.g. { systemName: "macOS 26" }). */
  getSystemInfo(): Promise<DesktopSystemInfo>;
  on(handler: (event: DesktopEvent) => void): () => void;
}
