import { IPC } from '../shared/contract';
import { handle, handle1, none, str, num, bool } from './ipc-handle';
import { redactQuery } from './log-file';
import type { PlayerBackend } from './mpv/player-backend';
import { parseLoadOptions, parseMuteRanges, parseSubtitleStyle, parseTrackId } from './player-parse';

/** What the renderer's player channels need from a platform: the player plus its window controls. */
export interface PlayerIpcHost {
  /** Resolves once the backend is up: a call before that waits, a failed start rejects it. */
  player(): Promise<PlayerBackend>;
  /** Playback was stopped by the renderer. */
  stop(): Promise<void>;
  setFullscreen(enabled: boolean): void;
  isFullscreen(): boolean;
  /** Absent where the page is the visible surface and its CSS cursor already applies. */
  setCursorVisible?(visible: boolean): void;
}

/** Wire the renderer→main invoke channels to the host's mpv player. */
export function registerPlayerIpc(
  host: PlayerIpcHost,
  hooks: { onPlaybackRate?: (rate: number) => void } = {},
): void {
  handle1(IPC.load, parseLoadOptions, async (opts) => {
    console.log('[ipc] load:', redactQuery(opts.url), 'start=', opts.startTime ?? 0, 'headers=', Object.keys(opts.headers ?? {}).join(','));
    return (await host.player()).load(opts);
  });
  handle(IPC.play, none, async () => (await host.player()).play());
  handle(IPC.pause, none, async () => (await host.player()).pause());
  handle1(IPC.seek, num, async (position) => (await host.player()).seek(position));
  handle(IPC.stop, none, () => host.stop());
  handle1(IPC.setPlaybackRate, num, async (rate) => {
    await (await host.player()).setPlaybackRate(rate);
    hooks.onPlaybackRate?.(rate);
  });
  handle1(IPC.setVolume, num, async (volume) => (await host.player()).setVolume(volume));
  handle1(IPC.setMuted, bool, async (muted) => (await host.player()).setMuted(muted));
  handle1(IPC.setMuteRanges, parseMuteRanges, async (ranges) => (await host.player()).setMuteRanges(ranges));
  handle(IPC.getPosition, none, async () => (await host.player()).getPosition());
  handle(IPC.getQoe, none, async () => (await host.player()).getQoe());
  handle(IPC.getAudioTracks, none, async () => (await host.player()).getAudioTracks());
  handle1(IPC.selectAudioTrack, (v) => str(v, 64), async (id) => (await host.player()).selectAudioTrack(id));
  handle(IPC.getSubtitleTracks, none, async () => (await host.player()).getSubtitleTracks());
  handle1(IPC.selectSubtitleTrack, parseTrackId, async (id) => (await host.player()).selectSubtitleTrack(id));
  handle(IPC.subAdd, (a) => [str(a[0], 8192), str(a[1], 512), str(a[2], 64)] as [string, string, string], async (url, label, language) =>
    (await host.player()).subAdd(url, label, language),
  );
  handle1(IPC.setSubtitleStyle, parseSubtitleStyle, async (style) => (await host.player()).setSubtitleStyle(style));
  handle1(IPC.setFillScreen, bool, async (fill) => (await host.player()).setFillScreen(fill));
  handle1(IPC.setCursorVisible, bool, (visible) => host.setCursorVisible?.(visible));
  handle1(IPC.setFullscreen, bool, (enabled) => host.setFullscreen(enabled));
  handle(IPC.isFullscreen, none, () => host.isFullscreen());
}
