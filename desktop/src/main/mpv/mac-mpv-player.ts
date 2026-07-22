// In-process libmpv player for macOS (the `fliks_player_mac` native addon).
//
// The addon embeds libmpv in a CAOpenGLLayer on the videoWin's NSView and
// exposes a property/command/event surface (mirroring the Linux compositor
// addon). This class adapts that surface to `PlayerBackend` so `PlayerSession`
// drives macOS exactly like the Windows subprocess player. The control logic is
// a near-copy of the Linux IPC handlers + event reshaping in `main/index.ts`.

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PlayerBackend, PlayerBackendEvents } from './player-backend';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopPlayerState,
  DesktopPositionInfo,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';
import { mpvSubtitleProps } from './subtitle-style';
import { mapTrackList, parseTracks, type MpvTrack } from './tracks';
import { TypedEmitter } from './typed-emitter';

type MacAddon = {
  start(o: { wid: string; scale?: number }): void;
  onEvent(cb: (json: string) => void): void;
  load(o: DesktopLoadOptions): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  /** Freeze-gated absolute seek (pauses output until the target frame lands). */
  seekTo(position: string): void;
  resize(): void;
  stop(): void;
};

export class MacMpvPlayer extends TypedEmitter<PlayerBackendEvents> implements PlayerBackend {
  private readonly addon: MacAddon;
  private readonly wid: string;
  private sawFirstFrame = false;
  // Last position/duration/buffered pushed by the addon's event-thread heartbeat.
  // getPosition() returns these cached values instead of a blocking main-thread
  // property read (which would take the mpv core lock and stall the next command).
  private lastPosition = 0;
  private lastDuration = 0;
  private lastBuffered = 0;

  constructor(videoWin: BrowserWindow) {
    super();
    // macOS getNativeWindowHandle() yields a pointer-sized (64-bit) NSView*; the
    // addon parses it back from a decimal string (a JS number can't hold it).
    this.wid = videoWin.getNativeWindowHandle().readBigUInt64LE(0).toString();

    // The .node addon and the dlopen'd libmpv are asarUnpack'd, so in a packaged
    // app they live under app.asar.unpacked. Mirror index.ts's Linux resolution.
    const base = app.isPackaged
      ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
      : app.getAppPath();
    if (!process.env.FLIKS_MPV_PATH) {
      process.env.FLIKS_MPV_PATH = path.join(base, 'native', 'vendor', 'libmpv.dylib');
    }
    const req = createRequire(__filename);
    this.addon = req(
      path.join(base, 'native', 'build', 'Release', 'fliks_player_mac.node'),
    ) as MacAddon;
  }

  async start(): Promise<this> {
    // Register the event callback BEFORE start so no early event is missed.
    this.addon.onEvent((json) => this.onAddonEvent(json));
    this.addon.start({ wid: this.wid });
    // Apply the shared streaming/reconnect tuning (all runtime-mutable, set
    // before the first load) so buffering + resume behaviour matches the other
    // backends from one source of truth.
    for (const [name, value] of MPV_STREAM_OPTIONS) this.addon.setProperty(name, value);
    return this;
  }

  // ── addon events → PlayerBackend events (mirrors index.ts addon.onEvent) ────
  private onAddonEvent(json: string): void {
    let raw: {
      type?: string;
      state?: DesktopPlayerState;
      position?: number;
      duration?: number;
      buffered?: number;
      message?: string;
      tracks?: MpvTrack[];
    };
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    switch (raw.type) {
      case 'timeUpdate': {
        // Position is pushed from the addon's mpv event thread (off the Electron
        // main thread) and already carries the buffered head — just forward it.
        const info: DesktopPositionInfo = {
          position: raw.position ?? 0,
          duration: raw.duration ?? 0,
          buffered: raw.buffered ?? 0,
        };
        this.lastPosition = info.position;
        this.lastDuration = info.duration;
        this.lastBuffered = info.buffered;
        this.emit('timeUpdate', info);
        break;
      }
      case 'stateChanged': {
        const state = raw.state;
        if (!state) break;
        this.emit('stateChanged', { state });
        break;
      }
      case 'tracksChanged':
        // The addon carries the committed track-list in the event (parity with
        // the Windows backend); map it directly. Re-reading via getProperty here
        // could observe a transient track state and churn the audio selection.
        this.emit('tracksChanged', mapTrackList(raw.tracks ?? []));
        break;
      case 'firstFrame':
        // Guard the event so a seek's playback-restart doesn't re-fire firstFrame
        // into the renderer.
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        break;
      case 'error':
        this.emit('error', { code: -1, message: raw.message ?? 'error' });
        break;
    }
  }

  // ── PlayerBackend surface (mirrors index.ts ipc handlers) ───────────────────
  async load(opts: DesktopLoadOptions): Promise<void> {
    this.sawFirstFrame = false;
    this.addon.load(opts);
  }

  async play(): Promise<void> {
    this.addon.setProperty('pause', 'no');
  }

  async pause(): Promise<void> {
    this.addon.setProperty('pause', 'yes');
  }

  async seek(position: number): Promise<void> {
    // Freeze-gated in the addon: output pauses the instant the seek is issued so
    // the old position can't keep playing while the demuxer repositions, and
    // resumes when the target frame lands (mpv PLAYBACK_RESTART).
    this.addon.seekTo(String(position));
  }

  async stop(): Promise<void> {
    this.sawFirstFrame = false;
    this.lastPosition = 0;
    this.lastDuration = 0;
    this.lastBuffered = 0;
    this.addon.command(['stop']);
  }

  async setPlaybackRate(rate: number): Promise<void> {
    this.addon.setProperty('speed', String(rate));
  }

  async setVolume(volume: number): Promise<void> {
    this.addon.setProperty('volume', String(volume));
  }

  async setMuted(muted: boolean): Promise<void> {
    this.addon.setProperty('mute', muted ? 'yes' : 'no');
  }

  async getPosition(): Promise<DesktopPositionInfo> {
    // The event-thread heartbeat is the single source of truth; return its last
    // pushed values rather than a blocking main-thread read (mirrors MpvPlayer).
    return {
      position: this.lastPosition,
      duration: this.lastDuration,
      buffered: this.lastBuffered,
    };
  }

  async getAudioTracks(): Promise<DesktopAudioTrack[]> {
    return parseTracks(this.addon.getProperty('track-list')).audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    this.addon.setProperty('aid', id);
  }

  async getSubtitleTracks(): Promise<DesktopSubtitleTrack[]> {
    return parseTracks(this.addon.getProperty('track-list')).subtitleTracks;
  }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    if (id == null) {
      this.addon.setProperty('sid', 'no');
      this.addon.setProperty('sub-visibility', 'no');
    } else {
      this.addon.setProperty('sid', id);
      this.addon.setProperty('sub-visibility', 'yes');
    }
  }

  async subAdd(url: string, label: string, language: string): Promise<void> {
    // `cached` makes mpv reuse an already-loaded track for the same URL, so
    // re-picking the same subtitle never stacks duplicates (matches Linux/win).
    this.addon.command(['sub-add', url, 'cached', label ?? '', language ?? '']);
  }

  async setSubtitleStyle(style: DesktopSubtitleStyle): Promise<void> {
    for (const [name, value] of mpvSubtitleProps(style)) this.addon.setProperty(name, value);
  }

  async destroy(): Promise<void> {
    this.addon.stop();
  }
}
