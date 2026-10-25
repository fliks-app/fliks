import { app } from 'electron';
import type { PlayerBackend, PlayerBackendEvents } from './player-backend';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopMuteRange,
  DesktopPositionInfo,
  DesktopQoe,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';
import { muteFilterCommands } from './edl-filter';
import { FirstFrameGate } from './first-frame-gate';
import { mpvLoadRequest, type MpvLoadRequest } from './load-options';
import { mpvSubtitleProps } from './subtitle-style';
import { parseTracks } from './tracks';
import { QoeReader } from './qoe';
import { isPrematureEof } from './eof-guard';
import { TypedEmitter } from './typed-emitter';

/** The native compositor addon: one SDL window drawing the mpv video under the UI bitmap. */
export type CompositorAddon = {
  start(o: { width: number; height: number; title: string; icon?: string }): void;
  onEvent(cb: (json: string) => void): void;
  onInput(cb: (json: string) => void): void;
  /** Dirty-rect upload: `rect` holds the pixels of (x, y, w, h) inside a frameW x frameH bitmap. */
  uploadUi(rect: Buffer, frameW: number, frameH: number, x: number, y: number, w: number, h: number): void;
  load(o: MpvLoadRequest): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  setFullscreen(enabled: boolean): void;
  setCursorVisible(visible: boolean): void;
  setCursorShape(shape: number): void;
  stop(): void;
};

/** libmpv inside the Linux compositor addon, as a `PlayerBackend`. `destroy()` stops playback only:
 *  the compositor window is the app's window and outlives it. */
export class LinuxCompositorPlayer extends TypedEmitter<PlayerBackendEvents> implements PlayerBackend {
  private readonly qoe = new QoeReader();
  private readonly firstFrameGate = new FirstFrameGate();
  private muteRanges: DesktopMuteRange[] = [];
  private muteFilterCount = 0;

  constructor(
    private readonly addon: CompositorAddon,
    private readonly window: { width: number; height: number; title: string; icon?: string },
  ) {
    super();
  }

  async start(): Promise<this> {
    this.addon.onEvent((json) => this.onAddonEvent(json));
    this.addon.start(this.window);
    for (const [name, value] of MPV_STREAM_OPTIONS) this.addon.setProperty(name, value);
    return this;
  }

  /** Last position pushed by the addon's event thread; `lastAt` keeps the last one with a known
   *  duration, since mpv drops both properties by the time EOF is reported. */
  private last: DesktopPositionInfo = { position: 0, duration: 0, buffered: 0 };
  private lastAt = { position: 0, duration: 0 };

  private onAddonEvent(json: string): void {
    let raw: { type?: string; state?: string; message?: string; position?: number; duration?: number; buffered?: number };
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    switch (raw.type) {
      case 'timeUpdate': {
        this.last = { position: raw.position ?? 0, duration: raw.duration ?? 0, buffered: raw.buffered ?? 0 };
        if (this.last.duration > 0) this.lastAt = { position: this.last.position, duration: this.last.duration };
        this.emit('timeUpdate', this.last);
        break;
      }
      case 'stateChanged': {
        const state = raw.state as PlayerBackendEvents['stateChanged'][0]['state'];
        if (state === 'ended' && isPrematureEof(this.lastAt.duration, this.lastAt.position)) {
          this.emit('error', { code: -1, message: 'playback stopped before end of stream' });
          break;
        }
        this.emit('stateChanged', { state });
        break;
      }
      case 'tracksChanged':
        this.emit('tracksChanged', parseTracks(this.addon.getProperty('track-list')));
        break;
      case 'firstFrame':
        this.firstFrameGate.release();
        this.emit('firstFrame');
        break;
      case 'error':
        this.firstFrameGate.release();
        this.emit('error', { code: -1, message: raw.message ?? 'error' });
        break;
      // The compositor owns the only visible window; the offscreen BrowserWindow never fires window-all-closed.
      case 'closed':
        app.quit();
        break;
    }
  }

  async load(opts: DesktopLoadOptions): Promise<void> {
    this.qoe.reset();
    this.last = { position: 0, duration: 0, buffered: 0 };
    this.lastAt = { position: 0, duration: 0 };
    // Global property: always written, or the previous file's rectangle would crop the next one.
    this.addon.setProperty('video-crop', opts.videoCrop ?? '');
    this.addon.setProperty('speed', '1');
    this.applyMuteRanges();
    this.addon.load(mpvLoadRequest(opts));
    await this.firstFrameGate.wait();
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
    this.firstFrameGate.release();
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

  async setMuteRanges(ranges: DesktopMuteRange[]): Promise<void> {
    this.muteRanges = ranges;
    this.applyMuteRanges();
  }

  private applyMuteRanges(): void {
    const { commands, count } = muteFilterCommands(this.muteRanges, this.muteFilterCount);
    this.muteFilterCount = count;
    for (const cmd of commands) this.addon.command(cmd);
  }

  async getPosition(): Promise<DesktopPositionInfo> {
    return this.last;
  }

  getQoe(): Promise<DesktopQoe | null> {
    return this.qoe.read((n) => this.addon.getProperty(n));
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
    this.addon.setProperty('sid', id ?? 'no');
    this.addon.setProperty('sub-visibility', id == null ? 'no' : 'yes');
  }

  async subAdd(url: string, label: string, language: string): Promise<void> {
    // `cached` reuses a track already loaded for the same URL.
    this.addon.command(['sub-add', url, 'cached', label ?? '', language ?? '']);
  }

  async setSubtitleStyle(style: DesktopSubtitleStyle): Promise<void> {
    if (!style) return;
    for (const [name, value] of mpvSubtitleProps(style)) this.addon.setProperty(name, value);
  }

  async setFillScreen(fill: boolean): Promise<void> {
    this.addon.setProperty('panscan', fill ? '1.0' : '0.0');
  }

  async destroy(): Promise<void> {
    this.muteRanges = [];
    this.applyMuteRanges();
    await this.stop();
  }
}
