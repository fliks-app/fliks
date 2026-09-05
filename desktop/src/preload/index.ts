import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  UPDATE_IPC,
  DOWNLOAD_IPC,
  CAST_IPC,
  type DesktopDownloadRequest,
  type DesktopDownloadStatus,
  type DesktopEvent,
  type DesktopLoadOptions,
  type DesktopRect,
  type DesktopSubtitleStyle,
  type DesktopUpdateStatus,
  type FliksDesktopApi,
  type FliksDownloaderApi,
  type DesktopCastEvent,
  type DesktopCastLoadOptions,
  type FliksCastApi,
  type FliksUpdaterApi,
} from '../shared/contract';

// Exposes the native player surface on `window.fliksDesktop`. The Angular-side
// DesktopEngine consumes this exactly as NativeEngine consumes the Capacitor
// NativePlayer plugin.
const api: FliksDesktopApi = {
  runtime: 'electron',
  load: (opts: DesktopLoadOptions) => ipcRenderer.invoke(IPC.load, opts),
  play: () => ipcRenderer.invoke(IPC.play),
  pause: () => ipcRenderer.invoke(IPC.pause),
  seek: (position: number) => ipcRenderer.invoke(IPC.seek, position),
  stop: () => ipcRenderer.invoke(IPC.stop),
  setPlaybackRate: (rate: number) => ipcRenderer.invoke(IPC.setPlaybackRate, rate),
  setVolume: (volume: number) => ipcRenderer.invoke(IPC.setVolume, volume),
  setMuted: (muted: boolean) => ipcRenderer.invoke(IPC.setMuted, muted),
  setFullscreen: (enabled: boolean) => ipcRenderer.invoke(IPC.setFullscreen, enabled),
  getPosition: () => ipcRenderer.invoke(IPC.getPosition),
  getAudioTracks: () => ipcRenderer.invoke(IPC.getAudioTracks),
  selectAudioTrack: (id: string) => ipcRenderer.invoke(IPC.selectAudioTrack, id),
  getSubtitleTracks: () => ipcRenderer.invoke(IPC.getSubtitleTracks),
  selectSubtitleTrack: (id: string | null) => ipcRenderer.invoke(IPC.selectSubtitleTrack, id),
  subAdd: (url: string, label: string, language: string) =>
    ipcRenderer.invoke(IPC.subAdd, url, label, language),
  setSubtitleStyle: (style: DesktopSubtitleStyle) =>
    ipcRenderer.invoke(IPC.setSubtitleStyle, style),
  setFillScreen: (fill: boolean) => ipcRenderer.invoke(IPC.setFillScreen, fill),
  resize: (rect: DesktopRect) => ipcRenderer.invoke(IPC.resize, rect),
  destroy: () => ipcRenderer.invoke(IPC.destroy),
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  on: (handler: (event: DesktopEvent) => void) => {
    const listener = (_e: unknown, event: DesktopEvent) => handler(event);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld('fliksDesktop', api);

// Exposes the in-app updater on `window.fliksUpdater`, consumed by the Angular
// AppUpdateService to drive the update button + changelog modal.
const updater: FliksUpdaterApi = {
  getCapability: () => ipcRenderer.invoke(UPDATE_IPC.getCapability),
  check: () => ipcRenderer.invoke(UPDATE_IPC.check),
  install: () => ipcRenderer.invoke(UPDATE_IPC.install),
  openReleases: () => ipcRenderer.invoke(UPDATE_IPC.openReleases),
  onStatus: (handler: (status: DesktopUpdateStatus) => void) => {
    const listener = (_e: unknown, status: DesktopUpdateStatus) => handler(status);
    ipcRenderer.on(UPDATE_IPC.status, listener);
    return () => ipcRenderer.removeListener(UPDATE_IPC.status, listener);
  },
};

contextBridge.exposeInMainWorld('fliksUpdater', updater);

// Exposes offline downloads on `window.fliksDownloader`, consumed by the Angular
// DownloadManager/OfflineStorage services on the desktop path.
const downloader: FliksDownloaderApi = {
  start: (req: DesktopDownloadRequest) => ipcRenderer.invoke(DOWNLOAD_IPC.start, req),
  cancel: (id: string) => ipcRenderer.invoke(DOWNLOAD_IPC.cancel, id),
  remove: (id: string) => ipcRenderer.invoke(DOWNLOAD_IPC.remove, id),
  list: () => ipcRenderer.invoke(DOWNLOAD_IPC.list),
  getLocalUrl: (id: string) => ipcRenderer.invoke(DOWNLOAD_IPC.getLocalUrl, id),
  saveFile: (key: string, url: string) => ipcRenderer.invoke(DOWNLOAD_IPC.saveFile, key, url),
  fileUrl: (key: string) => ipcRenderer.invoke(DOWNLOAD_IPC.fileUrl, key),
  deleteFile: (key: string) => ipcRenderer.invoke(DOWNLOAD_IPC.deleteFile, key),
  onStatus: (handler: (status: DesktopDownloadStatus) => void) => {
    const listener = (_e: unknown, status: DesktopDownloadStatus) => handler(status);
    ipcRenderer.on(DOWNLOAD_IPC.status, listener);
    return () => ipcRenderer.removeListener(DOWNLOAD_IPC.status, listener);
  },
};

contextBridge.exposeInMainWorld('fliksDownloader', downloader);

// Exposes the Chromecast sender on `window.fliksCast`. The Angular CastService
// consumes this exactly as it consumes the Capacitor NativeCast plugin: it
// re-dispatches each forwarded event as the window CustomEvent the plugin
// emits. contextIsolation keeps preload-world objects out of the page, so the
// events travel through contextBridge rather than a window dispatch here.
const cast: FliksCastApi = {
  initialize: (opts: { appId: string }) => ipcRenderer.invoke(CAST_IPC.initialize, opts.appId),
  isConnected: () => ipcRenderer.invoke(CAST_IPC.isConnected),
  requestSession: () => ipcRenderer.invoke(CAST_IPC.requestSession),
  getCastDevices: async () => ({ devices: await ipcRenderer.invoke(CAST_IPC.getDevices) }),
  selectCastDevice: (opts: { id: string }) => ipcRenderer.invoke(CAST_IPC.selectDevice, opts.id),
  loadMedia: (opts: DesktopCastLoadOptions) => ipcRenderer.invoke(CAST_IPC.load, opts),
  play: () => ipcRenderer.invoke(CAST_IPC.play),
  pause: () => ipcRenderer.invoke(CAST_IPC.pause),
  seek: (opts: { time: number }) => ipcRenderer.invoke(CAST_IPC.seek, opts.time),
  stop: () => ipcRenderer.invoke(CAST_IPC.stop),
  disconnect: () => ipcRenderer.invoke(CAST_IPC.disconnect),
  setVolume: (opts: { level: number }) => ipcRenderer.invoke(CAST_IPC.setVolume, opts.level),
  setMuted: (opts: { muted: boolean }) => ipcRenderer.invoke(CAST_IPC.setMuted, opts.muted),
  setActiveSubtitle: (opts: { trackId: number }) =>
    ipcRenderer.invoke(CAST_IPC.setActiveSubtitle, opts.trackId),
  setActiveAudioLanguage: (opts: { language: string; name: string }) =>
    ipcRenderer.invoke(CAST_IPC.setActiveAudioLanguage, opts.language, opts.name),
  on: (handler: (event: DesktopCastEvent) => void) => {
    const listener = (_e: unknown, event: DesktopCastEvent) => handler(event);
    ipcRenderer.on(CAST_IPC.event, listener);
    return () => ipcRenderer.removeListener(CAST_IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld('fliksCast', cast);
