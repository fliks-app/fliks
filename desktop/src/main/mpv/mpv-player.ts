// libmpv control plane over mpv's JSON IPC socket.
//
// Transport + control only: video output / hardware decode / embedding args
// are injected as `baseArgs` by the platform embed backend, keeping this class
// OS-agnostic. The method surface mirrors the mobile `NativePlayer` contract.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type {
  DesktopAudioTrack,
  DesktopLoadOptions,
  DesktopPositionInfo,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
} from '../../shared/contract';

const CONNECT_RETRY_MS = 30;
const CONNECT_TIMEOUT_MS = 5000;

interface MpvTrack {
  id: number;
  type: string;
  lang?: string;
  title?: string;
  selected?: boolean;
  forced?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface MpvPlayerOptions {
  /** Output / decode / embedding args from the platform backend (e.g. --wid, --vo). */
  baseArgs: string[];
  mpvPath?: string;
  /** Environment for the mpv process (e.g. X11-forced env from the backend). */
  env?: NodeJS.ProcessEnv;
}

export class MpvPlayer extends EventEmitter {
  private readonly mpvPath: string;
  private readonly baseArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly sockPath: string;
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private reqId = 0;
  private observeId = 0;
  private readonly pending = new Map<number, Pending>();
  private buf = '';
  private sawFirstFrame = false;
  private duration = 0;
  private cacheEnd = 0;

  constructor(opts: MpvPlayerOptions) {
    super();
    this.mpvPath = opts.mpvPath ?? 'mpv';
    this.baseArgs = opts.baseArgs;
    this.env = opts.env ?? process.env;
    // mpv's --input-ipc-server is a unix socket on POSIX but a NAMED PIPE on
    // Windows; Node's net only accepts the \\.\pipe\ namespace there (a /tmp
    // path is rejected), so build the path per-platform.
    const stamp = `fliks-mpv-${process.pid}-${this.reqId}-${Math.floor(performance.now())}`;
    this.sockPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\${stamp}`
        : path.join(os.tmpdir(), `${stamp}.sock`);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<this> {
    const args = [
      ...this.baseArgs,
      '--idle=yes',
      '--no-config',
      '--no-terminal',
      '--keep-open=yes',
      // The Fliks HLS references tokenised same-host segment/rendition URLs;
      // mpv's playlist safety check otherwise refuses them on the fallback path.
      '--load-unsafe-playlists=yes',
      `--input-ipc-server=${this.sockPath}`,
    ];
    console.log('[mpv] spawn:', this.mpvPath, args.join(' '));
    this.proc = spawn(this.mpvPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
    this.proc.on('exit', (code) => {
      this.emit('stateChanged', { state: 'idle' });
      this.emit('exit', { code });
    });
    this.proc.stderr?.on('data', (d: Buffer) => this.emit('log', d.toString()));

    await this.connect();
    await this.setupObservers();
    // Surface mpv's own warn/error log over IPC (ffmpeg HTTP/TLS/decode
    // failures) — `--no-terminal` suppresses stderr, so this is how we see why
    // a load failed.
    await this.command(['request_log_messages', 'warn']).catch(() => {});
    return this;
  }

  private async connect(): Promise<void> {
    const deadline = performance.now() + CONNECT_TIMEOUT_MS;
    // A Windows named pipe is not a filesystem entry, so existsSync never sees
    // it — connect directly and retry on error instead of gating on the file.
    const isPipe = process.platform === 'win32';
    for (;;) {
      if (isPipe || fs.existsSync(this.sockPath)) {
        try {
          await this.open();
          return;
        } catch {
          /* socket file exists but not accepting yet — retry */
        }
      }
      if (performance.now() > deadline) {
        throw new Error(`mpv IPC socket never appeared at ${this.sockPath}`);
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      sock.once('connect', () => {
        this.sock = sock;
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('error', (e) => this.emit('error', { code: -1, message: String(e) }));
        resolve();
      });
      sock.once('error', reject);
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id != null && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
        else p.resolve(msg.data);
      } else if (msg.event) {
        this.onEvent(msg);
      }
    }
  }

  private onEvent(msg: any): void {
    switch (msg.event) {
      case 'property-change':
        this.onProperty(msg.name, msg.data);
        break;
      case 'log-message':
        this.emit('log', `[${msg.level}] ${msg.prefix}: ${msg.text}`);
        break;
      case 'playback-restart':
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        break;
      case 'end-file':
        if (msg.reason === 'eof') this.emit('stateChanged', { state: 'ended' });
        else if (msg.reason === 'error')
          this.emit('error', { code: -1, message: msg.file_error ?? 'end-file error' });
        break;
      default:
        break;
    }
  }

  private onProperty(name: string, data: any): void {
    switch (name) {
      case 'time-pos':
        this.emit('timeUpdate', {
          position: data ?? 0,
          duration: this.duration,
          buffered: this.cacheEnd,
        } satisfies DesktopPositionInfo);
        break;
      case 'duration':
        this.duration = data ?? 0;
        break;
      case 'demuxer-cache-time':
        this.cacheEnd = data ?? 0;
        break;
      case 'pause':
        this.emit('stateChanged', { state: data ? 'paused' : 'playing' });
        break;
      case 'paused-for-cache':
        if (data) this.emit('stateChanged', { state: 'buffering' });
        break;
      case 'track-list':
        this.emit('tracksChanged', this.mapTracks(data ?? []));
        break;
      default:
        break;
    }
  }

  private async setupObservers(): Promise<void> {
    for (const prop of [
      'time-pos',
      'duration',
      'demuxer-cache-time',
      'pause',
      'paused-for-cache',
      'track-list',
    ]) {
      await this.command(['observe_property', ++this.observeId, prop]);
    }
  }

  // ── Command transport ──────────────────────────────────────────────────

  private command(command: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('mpv socket not connected'));
      const request_id = ++this.reqId;
      this.pending.set(request_id, { resolve, reject });
      this.sock.write(JSON.stringify({ command, request_id }) + '\n');
    });
  }

  private get(prop: string): Promise<any> {
    return this.command(['get_property', prop]);
  }

  private set(prop: string, value: unknown): Promise<void> {
    return this.command(['set_property', prop, value]);
  }

  // ── NativePlayer-equivalent surface ──────────────────────────────────────

  async load(opts: DesktopLoadOptions): Promise<void> {
    this.sawFirstFrame = false;
    const fileOpts: string[] = [];
    if (opts.startTime && opts.startTime > 0) fileOpts.push(`start=+${opts.startTime}`);
    if (opts.headers && Object.keys(opts.headers).length) {
      const fields = Object.entries(opts.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join(',');
      fileOpts.push(`http-header-fields=${fields}`);
    }
    await this.command(['loadfile', opts.url, 'replace', fileOpts.join(',')]);
    for (const s of opts.subtitles ?? []) {
      await this.command(['sub-add', s.url, 'auto', s.label ?? '', s.language ?? '']);
    }
  }

  play(): Promise<void> {
    return this.set('pause', false);
  }

  pause(): Promise<void> {
    return this.set('pause', true);
  }

  seek(position: number): Promise<void> {
    return this.command(['seek', position, 'absolute']).then(() => undefined);
  }

  stop(): Promise<void> {
    // Reset baselines so the persistent player can't replay a stale first-frame
    // / position into the next session after a back-navigation.
    this.sawFirstFrame = false;
    this.duration = 0;
    this.cacheEnd = 0;
    return this.command(['stop']).then(() => undefined);
  }

  setPlaybackRate(rate: number): Promise<void> {
    return this.set('speed', rate);
  }

  setVolume(volume: number): Promise<void> {
    return this.set('volume', volume);
  }

  setMuted(muted: boolean): Promise<void> {
    return this.set('mute', muted);
  }

  async getPosition(): Promise<DesktopPositionInfo> {
    return {
      position: (await this.get('time-pos').catch(() => 0)) ?? 0,
      duration: (await this.get('duration').catch(() => 0)) ?? 0,
      buffered: (await this.get('demuxer-cache-time').catch(() => 0)) ?? 0,
    };
  }

  private mapTracks(list: MpvTrack[]): {
    audioTracks: DesktopAudioTrack[];
    subtitleTracks: DesktopSubtitleTrack[];
  } {
    const audioTracks: DesktopAudioTrack[] = [];
    const subtitleTracks: DesktopSubtitleTrack[] = [];
    for (const t of list) {
      if (t.type === 'audio')
        audioTracks.push({
          id: String(t.id),
          language: t.lang ?? '',
          label: t.title ?? '',
          selected: !!t.selected,
        });
      else if (t.type === 'sub')
        subtitleTracks.push({
          id: String(t.id),
          language: t.lang ?? '',
          label: t.title ?? '',
          forced: !!t.forced,
          selected: !!t.selected,
        });
    }
    return { audioTracks, subtitleTracks };
  }

  async getAudioTracks(): Promise<DesktopAudioTrack[]> {
    return this.mapTracks((await this.get('track-list')) ?? []).audioTracks;
  }

  selectAudioTrack(id: string): Promise<void> {
    return this.set('aid', id);
  }

  async getSubtitleTracks(): Promise<DesktopSubtitleTrack[]> {
    return this.mapTracks((await this.get('track-list')) ?? []).subtitleTracks;
  }

  selectSubtitleTrack(id: string | null): Promise<void> {
    return this.set('sid', id == null ? 'no' : id);
  }

  async setSubtitleStyle(s: DesktopSubtitleStyle): Promise<void> {
    await this.set('sub-font-size', Math.round(55 * (s.fontScale ?? 1)));
    if (s.foregroundColor) await this.set('sub-color', s.foregroundColor);
    if (s.backgroundColor && s.backgroundColor !== 'transparent') {
      await this.set('sub-back-color', s.backgroundColor);
      await this.set('sub-border-style', 'background-box');
    }
    if (s.bottomMarginPercent != null) await this.set('sub-pos', 100 - s.bottomMarginPercent);
  }

  async destroy(): Promise<void> {
    try {
      await this.command(['quit']);
    } catch {
      /* socket may already be gone */
    }
    this.sock?.destroy();
    this.proc?.kill('SIGTERM');
    try {
      if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
    } catch {
      /* best effort */
    }
  }
}
