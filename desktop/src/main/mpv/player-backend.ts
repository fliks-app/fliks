import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopPlayerState,
  DesktopPositionInfo,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';
import type { TypedEmitter } from './typed-emitter';

/** Events every backend emits; `PlayerSession.forwardEvents` subscribes to each
 *  and reshapes it onto the `DesktopEvent` IPC channel. A `type` (not an
 *  interface) so it satisfies {@link TypedEmitter}'s event-map constraint. */
export type PlayerBackendEvents = {
  /** A raw mpv log line (already level-prefixed). */
  log: [message: string];
  /** The player process/engine terminated. */
  exit: [info: { code: number | null; signal: NodeJS.Signals | null }];
  stateChanged: [payload: { state: DesktopPlayerState }];
  timeUpdate: [payload: DesktopPositionInfo];
  tracksChanged: [
    payload: { audioTracks: DesktopAudioTrack[]; subtitleTracks: DesktopSubtitleTrack[] },
  ];
  firstFrame: [];
  error: [payload: { code: number; message: string; detail?: string }];
};

/**
 * The control surface a platform player must expose to `PlayerSession` /
 * `ipc.ts`. Both the cross-platform JSON-IPC subprocess player (`MpvPlayer`,
 * Windows) and the in-process libmpv player (`MacMpvPlayer`, macOS) implement
 * it, so the session and the renderer IPC stay OS-agnostic.
 *
 * It is a {@link TypedEmitter} of {@link PlayerBackendEvents}, so subscribers get
 * a compile-time-checked event name and payload with no defensive casting.
 */
export interface PlayerBackend extends TypedEmitter<PlayerBackendEvents> {
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
