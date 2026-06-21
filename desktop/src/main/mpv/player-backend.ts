import type { EventEmitter } from 'node:events';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopPositionInfo,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';

/**
 * The control surface a platform player must expose to `PlayerSession` /
 * `ipc.ts`. Both the cross-platform JSON-IPC subprocess player (`MpvPlayer`,
 * Windows) and the in-process libmpv player (`MacMpvPlayer`, macOS) implement
 * it, so the session and the renderer IPC stay OS-agnostic.
 *
 * It extends `EventEmitter` because `PlayerSession.forwardEvents` subscribes to
 * `log`, `exit`, `stateChanged`, `timeUpdate`, `tracksChanged`, `firstFrame` and
 * `error`. `MpvPlayer` already satisfies this unchanged.
 */
export interface PlayerBackend extends EventEmitter {
  start(): Promise<unknown>;
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
  subAdd(url: string, label: string, language: string): Promise<void>;
  setSubtitleStyle(style: DesktopSubtitleStyle): Promise<void>;
  destroy(): Promise<void>;
}
