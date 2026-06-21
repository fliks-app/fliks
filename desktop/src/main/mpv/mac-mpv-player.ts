// In-process libmpv player for macOS (the `fliks_player_mac` native addon).
//
// The addon embeds libmpv in a CAOpenGLLayer on the videoWin's NSView and
// exposes a property/command/event surface (mirroring the Linux compositor
// addon). This class adapts that surface to `PlayerBackend` so `PlayerSession`
// drives macOS exactly like the Windows subprocess player. The control logic is
// a near-copy of the Linux IPC handlers + event reshaping in `main/index.ts`.

import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PlayerBackend } from './player-backend';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopPositionInfo,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';
import { mpvSubtitleProps } from './subtitle-style';
import { parseTracks } from './tracks';

// Cadence of the periodic position emit while playing. As on Linux, the addon's
// `time-pos` observe doesn't push while playback advances, so the seekbar + the
// renderer's 10s resume-save heartbeat stay frozen unless the main process polls
// and emits the position itself. ~250ms (4Hz) keeps the bar smooth.
const POSITION_POLL_MS = 250;

type MacAddon = {
  start(o: { wid: string; scale?: number }): void;
  onEvent(cb: (json: string) => void): void;
  load(o: DesktopLoadOptions): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  resize(): void;
  stop(): void;
};

const num = (v: string | null): number => {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export class MacMpvPlayer extends EventEmitter implements PlayerBackend {
  private readonly addon: MacAddon;
  private readonly wid: string;
  private sawFirstFrame = false;
  private positionTimer: ReturnType<typeof setInterval> | null = null;

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
    return this;
  }

  // ── addon events → PlayerBackend events (mirrors index.ts addon.onEvent) ────
  private onAddonEvent(json: string): void {
    let raw: { type?: string; state?: string; position?: number; duration?: number; message?: string };
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    switch (raw.type) {
      case 'timeUpdate':
        this.emit('timeUpdate', {
          position: raw.position ?? 0,
          duration: raw.duration ?? 0,
          buffered: num(this.addon.getProperty('demuxer-cache-time')),
        } satisfies DesktopPositionInfo);
        break;
      case 'stateChanged':
        // Only an actively-playing session drives the poll; pausing / ending /
        // buffering / idle stops it so a torn-down player can't keep emitting.
        if (raw.state === 'playing') this.startPositionTimer();
        else this.stopPositionTimer();
        this.emit('stateChanged', { state: raw.state });
        break;
      case 'tracksChanged':
        this.emit('tracksChanged', parseTracks(this.addon.getProperty('track-list')));
        break;
      case 'firstFrame':
        // mpv autoplays on load (addon forces pause=no) but may not emit a pause
        // change, so arm the timer on the first frame too. Guard the event so a
        // seek's playback-restart doesn't re-fire firstFrame into the renderer.
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        this.startPositionTimer();
        break;
      case 'error':
        this.stopPositionTimer();
        this.emit('error', { code: -1, message: raw.message ?? 'error' });
        break;
    }
  }

  private emitPosition(): void {
    this.emit('timeUpdate', {
      position: num(this.addon.getProperty('time-pos')),
      duration: num(this.addon.getProperty('duration')),
      buffered: num(this.addon.getProperty('demuxer-cache-time')),
    } satisfies DesktopPositionInfo);
  }

  private startPositionTimer(): void {
    if (this.positionTimer) return; // idempotent — never stack intervals
    this.emitPosition(); // emit immediately so the bar doesn't wait a full tick
    this.positionTimer = setInterval(() => this.emitPosition(), POSITION_POLL_MS);
  }

  private stopPositionTimer(): void {
    if (!this.positionTimer) return;
    clearInterval(this.positionTimer);
    this.positionTimer = null;
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
    this.addon.command(['seek', String(position), 'absolute']);
  }

  async stop(): Promise<void> {
    this.sawFirstFrame = false;
    this.stopPositionTimer();
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
    return {
      position: num(this.addon.getProperty('time-pos')),
      duration: num(this.addon.getProperty('duration')),
      buffered: num(this.addon.getProperty('demuxer-cache-time')),
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
    this.stopPositionTimer();
    this.addon.stop();
  }
}
