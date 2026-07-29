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
  /** Preferred audio language (mpv `alang`). Applied as a file-local loadfile
   *  option so mpv auto-selects the matching audio rendition on the initial load
   *  AND on every mid-file reconfig — without a client round-trip. Neutralises
   *  the "mpv reverts to the manifest default language on reconfig" churn. Both
   *  the macOS in-process backend and the Windows subprocess consume it; the
   *  Linux compositor backend does not. */
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
  | {
      type: 'error';
      /** `code` follows MediaError semantics where applicable: 2
       *  (MEDIA_ERR_NETWORK) marks a transport-level failure (mpv's own
       *  TLS/libcurl signature — see `MpvPlayer.errorPayload`), so the client
       *  classifies it as network/abort instead of blaming the decode path
       *  (e.g. Dolby Vision). Any other value carries no MediaError meaning. */
      payload: { code: number; message: string; detail?: string };
    };

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
  setFillScreen: 'player:setFillScreen',
  resize: 'player:resize',
  destroy: 'player:destroy',
  /** Host OS identity (name + version), resolved natively. */
  getSystemInfo: 'system:info',
  /** main → renderer (one channel, discriminated by DesktopEvent.type). */
  event: 'player:event',
} as const;

export interface DesktopUpdateInfo {
  version: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  releaseUrl: string | null;
}

export type DesktopUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: DesktopUpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; info: DesktopUpdateInfo }
  | { state: 'error'; message: string };

/** `canInstall` is false where electron-updater can't self-install (.deb, dev)
 *  → the UI offers a download link to `releasesUrl` instead. */
export interface DesktopUpdateCapability {
  canInstall: boolean;
  currentVersion: string;
  releasesUrl: string;
}

export const UPDATE_IPC = {
  check: 'update:check',
  install: 'update:install',
  openReleases: 'update:openReleases',
  getCapability: 'update:getCapability',
  /** main → renderer (discriminated by DesktopUpdateStatus.state). */
  status: 'update:status',
} as const;

// ── Downloads (offline) ──
// App-level, independent of the per-session player surface — modelled on the
// updater. Media is fetched to disk and played back offline via mpv (file://).

export interface DesktopDownloadRequest {
  /** Stable id; the client uses the mediaFileId. */
  id: string;
  /** Source URL, including the ?token= stream JWT. A `.m3u8` URL is mirrored to
   *  disk as a local HLS bundle; anything else is fetched as a single file. */
  url: string;
  /** Preferred display filename; the on-disk extension is taken from the response. */
  filename?: string;
  /** For an HLS download, the ladder rung to mirror (variant selection). */
  quality?: string;
}

export interface DesktopDownloadItem {
  id: string;
  filename: string;
  /** Absolute local path of the downloaded file. */
  path: string;
  /** Total bytes (0 until the response headers arrive). */
  size: number;
  received: number;
  complete: boolean;
}

export type DesktopDownloadStatus =
  | { id: string; state: 'progress'; received: number; total: number }
  | { id: string; state: 'done'; item: DesktopDownloadItem }
  | { id: string; state: 'error'; message: string };

export const DOWNLOAD_IPC = {
  start: 'download:start',
  cancel: 'download:cancel',
  remove: 'download:remove',
  list: 'download:list',
  getLocalUrl: 'download:getLocalUrl',
  saveFile: 'download:saveFile',
  fileUrl: 'download:fileUrl',
  deleteFile: 'download:deleteFile',
  /** main → renderer (discriminated by DesktopDownloadStatus.state). */
  status: 'download:status',
} as const;

/** Exposed on `window.fliksDownloader` by the preload bridge. */
export interface FliksDownloaderApi {
  start(req: DesktopDownloadRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<DesktopDownloadItem[]>;
  /** file:// URL of a completed download, or null. */
  getLocalUrl(id: string): Promise<string | null>;
  /** Fetch a small sidecar file (e.g. a VTT subtitle) to disk under `key`. */
  saveFile(key: string, url: string): Promise<boolean>;
  /** file:// URL of a saved sidecar file, or null. */
  fileUrl(key: string): Promise<string | null>;
  deleteFile(key: string): Promise<void>;
  onStatus(handler: (status: DesktopDownloadStatus) => void): () => void;
}

/** Exposed on `window.fliksUpdater` by the preload bridge. */
export interface FliksUpdaterApi {
  getCapability(): Promise<DesktopUpdateCapability>;
  check(): Promise<void>;
  /** Download + install + relaunch. No-op when !canInstall. */
  install(): Promise<void>;
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
  /** Crop the video to fill the window (mpv `panscan`) instead of letterboxing. */
  setFillScreen(fill: boolean): Promise<void>;
  resize(rect: DesktopRect): Promise<void>;
  destroy(): Promise<void>;
  /** Native host OS identity (e.g. { systemName: "macOS 26" }). */
  getSystemInfo(): Promise<DesktopSystemInfo>;
  on(handler: (event: DesktopEvent) => void): () => void;
}
