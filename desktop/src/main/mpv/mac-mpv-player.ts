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

// Cap on load()'s first-frame wait. A file that never opens (dead stream, bad
// URL) must not hang the load promise; the timeout resolves it so the caller
// proceeds. Matches the Windows backend's FIRST_FRAME_TIMEOUT_MS.
const FIRST_FRAME_TIMEOUT_MS = 15_000;

type MacAddon = {
  start(o: { wid: string; scale?: number }): void;
  onEvent(cb: (json: string) => void): void;
  load(o: DesktopLoadOptions): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  resize(): void;
  setBottomCornerRadius(wid: string, radius: number): void;
  stop(): void;
};

/** Resolve + require the native addon (singleton across the process). The .node
 *  addon and the dlopen'd libmpv are asarUnpack'd, so in a packaged app they
 *  live under app.asar.unpacked. */
let macAddon: MacAddon | null = null;
function loadMacAddon(): MacAddon {
  if (macAddon) return macAddon;
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath();
  if (!process.env.FLIKS_MPV_PATH) {
    process.env.FLIKS_MPV_PATH = path.join(base, 'native', 'vendor', 'libmpv.dylib');
  }
  macAddon = createRequire(__filename)(
    path.join(base, 'native', 'build', 'Release', 'fliks_player_mac.node'),
  ) as MacAddon;
  return macAddon;
}

/** Clip a window's content view to a square-top / rounded-bottom shape. Call on
 *  create and on every resize with the window's current bounds. */
export function roundWindowBottomCorners(win: BrowserWindow, radius: number): void {
  const wid = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  loadMacAddon().setBottomCornerRadius(wid, radius);
}

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
  /** Resolver for the in-flight load()'s first-frame wait; see load(). */
  private firstFrameResolve: (() => void) | null = null;

  constructor(videoWin: BrowserWindow) {
    super();
    // macOS getNativeWindowHandle() yields a pointer-sized (64-bit) NSView*; the
    // addon parses it back from a decimal string (a JS number can't hold it).
    this.wid = videoWin.getNativeWindowHandle().readBigUInt64LE(0).toString();
    this.addon = loadMacAddon();
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
        // Unblock a pending load() (the new file has opened) and guard the event
        // so a seek's playback-restart doesn't re-fire firstFrame into the renderer.
        this.firstFrameResolve?.();
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        break;
      case 'error':
        this.firstFrameResolve?.(); // don't hang a load() that failed to open
        this.emit('error', { code: -1, message: raw.message ?? 'error' });
        break;
    }
  }

  // ── PlayerBackend surface (mirrors index.ts ipc handlers) ───────────────────
  async load(opts: DesktopLoadOptions): Promise<void> {
    // Resolve any superseded in-flight load wait, then wait for the NEW file to
    // actually open (first decoded frame) before resolving — mirroring the
    // Windows backend. addon.load() only QUEUES loadfile, so returning early
    // would let a caller's post-load sub-add / track-select run while no file is
    // open (mpv rejects it → the sidecar subtitle is lost on a reload seek). The
    // timeout + the error path keep an aborted load from hanging.
    this.firstFrameResolve?.();
    this.sawFirstFrame = false;
    this.addon.load(opts);
    await this.waitFirstFrame();
  }

  private waitFirstFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.firstFrameResolve === done) this.firstFrameResolve = null;
        resolve();
      };
      const timer = setTimeout(done, FIRST_FRAME_TIMEOUT_MS);
      this.firstFrameResolve = done;
    });
  }

  async play(): Promise<void> {
    this.addon.setProperty('pause', 'no');
  }

  async pause(): Promise<void> {
    this.addon.setProperty('pause', 'yes');
  }

  async seek(position: number): Promise<void> {
    // Plain in-place absolute seek, same as the Windows backend. A far seek in a
    // multi-audio transcode reloads instead, via the shared seekByReload path one
    // level up; this backend only performs the ordinary in-place case. The loading
    // spinner is driven by mpv core-idle in the addon, so no seek-time pause is
    // needed.
    this.addon.command(['seek', String(position), 'absolute']);
  }

  async stop(): Promise<void> {
    this.firstFrameResolve?.(); // a stop cancels any pending load's first-frame wait
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

  async setFillScreen(fill: boolean): Promise<void> {
    this.addon.setProperty('panscan', fill ? '1.0' : '0.0');
  }

  async destroy(): Promise<void> {
    this.firstFrameResolve?.(); // don't leave a pending load() hanging on teardown
    this.addon.stop();
  }
}
