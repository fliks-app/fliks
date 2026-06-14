import { ipcMain } from 'electron';
import { IPC } from '../shared/contract';
import type { PlayerSession } from './window/player-session';
import type {
  DesktopLoadOptions,
  DesktopRect,
  DesktopSubtitleStyle,
} from '../shared/contract';

/** Wire the renderer→main invoke channels to the session's mpv player. */
export function registerPlayerIpc(session: PlayerSession): void {
  ipcMain.handle(IPC.load, (_e, opts: DesktopLoadOptions) => {
    console.log('[ipc] load:', opts.url, 'start=', opts.startTime ?? 0, 'headers=', Object.keys(opts.headers ?? {}).join(','));
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
  ipcMain.handle(IPC.getPosition, () => session.player.getPosition());
  ipcMain.handle(IPC.getAudioTracks, () => session.player.getAudioTracks());
  ipcMain.handle(IPC.selectAudioTrack, (_e, id: string) => session.player.selectAudioTrack(id));
  ipcMain.handle(IPC.getSubtitleTracks, () => session.player.getSubtitleTracks());
  ipcMain.handle(IPC.selectSubtitleTrack, (_e, id: string | null) =>
    session.player.selectSubtitleTrack(id),
  );
  ipcMain.handle(IPC.setSubtitleStyle, (_e, style: DesktopSubtitleStyle) =>
    session.player.setSubtitleStyle(style),
  );
  ipcMain.handle(IPC.resize, (_e, rect: DesktopRect) => session.resize(rect));
  ipcMain.handle(IPC.destroy, () => session.destroy());
}
