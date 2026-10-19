import { ipcMain } from 'electron';
import { IPC } from '../shared/contract';
import { redactQuery } from './log-file';
import type { PlayerBackend } from './mpv/player-backend';
import type {
  DesktopLoadOptions,
  DesktopMuteRange,
  DesktopRect,
  DesktopSubtitleStyle,
} from '../shared/contract';

/** What the renderer's player channels need from a platform: the player plus its window controls. */
export interface PlayerIpcHost {
  readonly player: PlayerBackend;
  setFullscreen(enabled: boolean): void;
  resize(rect: DesktopRect): void;
  destroy(): Promise<void>;
  /** Absent where the page is the visible surface and its CSS cursor already applies. */
  setCursorVisible?(visible: boolean): void;
}

/** Wire the renderer→main invoke channels to the host's mpv player. */
export function registerPlayerIpc(session: PlayerIpcHost): void {
  ipcMain.handle(IPC.load, (_e, opts: DesktopLoadOptions) => {
    console.log('[ipc] load:', redactQuery(opts.url), 'start=', opts.startTime ?? 0, 'headers=', Object.keys(opts.headers ?? {}).join(','));
    return session.player.load(opts);
  });
  ipcMain.handle(IPC.play, () => {
    console.log('[ipc] play');
    return session.player.play();
  });
  ipcMain.handle(IPC.pause, () => session.player.pause());
  ipcMain.handle(IPC.seek, (_e, position: number) => {
    console.log('[ipc] seek:', position);
    return session.player.seek(position);
  });
  ipcMain.handle(IPC.stop, () => session.player.stop());
  ipcMain.handle(IPC.setPlaybackRate, (_e, rate: number) => session.player.setPlaybackRate(rate));
  ipcMain.handle(IPC.setVolume, (_e, volume: number) => session.player.setVolume(volume));
  ipcMain.handle(IPC.setMuted, (_e, muted: boolean) => session.player.setMuted(muted));
  ipcMain.handle(IPC.setMuteRanges, (_e, ranges: DesktopMuteRange[]) =>
    session.player.setMuteRanges(ranges),
  );
  ipcMain.handle(IPC.getPosition, () => session.player.getPosition());
  ipcMain.handle(IPC.getQoe, () => session.player.getQoe());
  ipcMain.handle(IPC.getAudioTracks, () => session.player.getAudioTracks());
  ipcMain.handle(IPC.selectAudioTrack, (_e, id: string) => session.player.selectAudioTrack(id));
  ipcMain.handle(IPC.getSubtitleTracks, () => session.player.getSubtitleTracks());
  ipcMain.handle(IPC.selectSubtitleTrack, (_e, id: string | null) =>
    session.player.selectSubtitleTrack(id),
  );
  ipcMain.handle(IPC.subAdd, (_e, url: string, label: string, language: string) =>
    session.player.subAdd(url, label, language),
  );
  ipcMain.handle(IPC.setSubtitleStyle, (_e, style: DesktopSubtitleStyle) =>
    session.player.setSubtitleStyle(style),
  );
  ipcMain.handle(IPC.setFillScreen, (_e, fill: boolean) => session.player.setFillScreen(fill));
  ipcMain.handle(IPC.setCursorVisible, (_e, visible: boolean) => session.setCursorVisible?.(visible));
  ipcMain.handle(IPC.setFullscreen, (_e, enabled: boolean) => session.setFullscreen(enabled));
  ipcMain.handle(IPC.resize, (_e, rect: DesktopRect) => session.resize(rect));
  ipcMain.handle(IPC.destroy, () => session.destroy());
}
