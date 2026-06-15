import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type DesktopEvent,
  type DesktopLoadOptions,
  type DesktopRect,
  type DesktopSubtitleStyle,
  type FliksDesktopApi,
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
  resize: (rect: DesktopRect) => ipcRenderer.invoke(IPC.resize, rect),
  destroy: () => ipcRenderer.invoke(IPC.destroy),
  on: (handler: (event: DesktopEvent) => void) => {
    const listener = (_e: unknown, event: DesktopEvent) => handler(event);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld('fliksDesktop', api);
