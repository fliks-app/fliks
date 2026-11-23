import type { PlayerBackend, PlayerBackendEvents } from './player-backend';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopMuteRange,
  DesktopPlayerState,
  DesktopPositionInfo,
  DesktopQoe,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';
import { mpvStreamOptions } from './stream-options';
import { muteFilterCommands } from './edl-filter';
import { FirstFrameGate } from './first-frame-gate';
import { mpvLoadRequest, type MpvLoadRequest } from './load-options';
import { mpvSubtitleProps } from './subtitle-style';
import { mapTrackList, parseTracks, type MpvTrack } from './tracks';
import { QoeReader } from './qoe';
import { MpvErrorLog } from './error-log';
import { isPrematureEof } from './eof-guard';
import { TypedEmitter } from './typed-emitter';

/** What the macOS and Linux libmpv addons share: mpv in-process, JSON events out, properties and commands in. */
export interface LibmpvAddon {
  onEvent(cb: (json: string) => void): void;
  load(o: MpvLoadRequest): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  stop(): void;
}

/** The window model of a platform: how its addon starts and what ends the session. */
export interface LibmpvPlatform {
  /** Starts the addon, once the event callback is registered. */
  start(): void;
  /** Ends the session. */
  destroy(): void;
  /** An addon event of the platform's own (window focus, full screen, close). */
  onEvent?(raw: { type?: string; active?: boolean }): void;
}

type AddonEvent = {
  type?: string;
  active?: boolean;
  state?: DesktopPlayerState;
  position?: number;
  duration?: number;
  buffered?: number;
  message?: string;
  tracks?: MpvTrack[];
  level?: string;
  prefix?: string;
  text?: string;
};

/** libmpv inside a native addon, as a `PlayerBackend`; one class for macOS and Linux. */
export class LibmpvAddonPlayer extends TypedEmitter<PlayerBackendEvents> implements PlayerBackend {
  private readonly qoe = new QoeReader();
  private readonly firstFrameGate = new FirstFrameGate();
  private readonly errorLog = new MpvErrorLog();
  private sawFirstFrame = false;
  private muteRanges: DesktopMuteRange[] = [];
  private muteFilterCount = 0;
  /** Last position pushed by the addon's event thread, so reads never block the main thread on mpv's core lock. */
  private last: DesktopPositionInfo = { position: 0, duration: 0, buffered: 0 };
  /** The last position seen with a known duration: mpv drops both properties by the time EOF is reported. */
  private lastAt = { position: 0, duration: 0 };

  constructor(
    private readonly addon: LibmpvAddon,
    private readonly platform: LibmpvPlatform,
  ) {
    super();
  }

  async start(): Promise<this> {
    this.addon.onEvent((json) => this.onAddonEvent(json));
    this.platform.start();
    for (const [name, value] of mpvStreamOptions()) this.addon.setProperty(name, value);
    return this;
  }

  private onAddonEvent(json: string): void {
    let raw: AddonEvent;
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    switch (raw.type) {
      case 'timeUpdate':
        this.last = { position: raw.position ?? 0, duration: raw.duration ?? 0, buffered: raw.buffered ?? 0 };
        if (this.last.duration > 0) this.lastAt = { position: this.last.position, duration: this.last.duration };
        this.emit('timeUpdate', this.last);
        break;
      case 'stateChanged':
        if (!raw.state) break;
        if (raw.state === 'ended' && isPrematureEof(this.lastAt.duration, this.lastAt.position)) {
          this.emit('error', this.errorLog.payload('playback stopped before end of stream'));
          break;
        }
        this.emit('stateChanged', { state: raw.state });
        break;
      case 'tracksChanged':
        // The committed list rides on the event: a property read here could see a transient track state.
        this.emit('tracksChanged', mapTrackList(raw.tracks ?? []));
        break;
      case 'firstFrame':
        // Every seek restarts playback: only the first one of a load is the frame.
        this.firstFrameGate.release();
        this.errorLog.reset();
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        break;
      case 'log':
        this.errorLog.record(raw.level ?? '', raw.prefix, raw.text);
        this.emit('log', `[${raw.level}] ${raw.prefix ? `${raw.prefix}: ` : ''}${raw.text ?? ''}\n`);
        break;
      case 'error':
        this.firstFrameGate.release();
        this.emit('error', this.errorLog.payload(raw.message ?? 'error'));
        break;
      default:
        this.platform.onEvent?.(raw);
    }
  }

  async load(opts: DesktopLoadOptions): Promise<void> {
    this.qoe.reset();
    this.sawFirstFrame = false;
    this.errorLog.reset();
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
    // In place; a far seek in a multi-audio transcode reloads one level up.
    this.addon.command(['seek', String(position), 'absolute']);
  }

  async stop(): Promise<void> {
    this.firstFrameGate.release();
    this.sawFirstFrame = false;
    this.last = { position: 0, duration: 0, buffered: 0 };
    this.lastAt = { position: 0, duration: 0 };
    const { commands } = muteFilterCommands([], this.muteFilterCount);
    this.muteFilterCount = 0;
    for (const cmd of commands) this.addon.command(cmd);
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

  getQoe(): Promise<DesktopQoe | null> {
    return this.qoe.read((n) => this.addon.getProperty(n));
  }

  async getPosition(): Promise<DesktopPositionInfo> {
    return this.last;
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
    for (const [name, value] of mpvSubtitleProps(style)) this.addon.setProperty(name, value);
  }

  async setFillScreen(fill: boolean): Promise<void> {
    this.addon.setProperty('panscan', fill ? '1.0' : '0.0');
  }

  async destroy(): Promise<void> {
    this.muteRanges = [];
    this.firstFrameGate.release();
    this.platform.destroy();
  }
}
