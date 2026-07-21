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
import { mpvSubtitleProps } from './subtitle-style';
import { isImageBasedSubtitleCodec } from './tracks';

const CONNECT_RETRY_MS = 30;
const CONNECT_TIMEOUT_MS = 5000;

interface MpvTrack {
  id: number;
  type: string;
  codec?: string;
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
  /** One-shot per load: `--keep-open=yes` makes mpv pause on the last frame and
   *  set `eof-reached` instead of firing an `end-file`(eof) event, so the
   *  natural end is detected from that property. Guards against mpv re-sending
   *  the property-change so `ended` (which drives auto-advance) emits once. */
  private sawEof = false;
  private duration = 0;
  private cacheEnd = 0;
  /** Demuxer format forced for the current media (`hls` for manifests, else
   *  empty). Dropped around a sidecar `sub-add` so the VTT isn't demuxed as HLS. */
  private forcedDemuxFormat = '';
  /** Bumped by load/stop/destroy; a load with a stale id skips its remaining
   *  IPC writes, so a stop can't be overtaken by a trailing loadfile. */
  private loadGen = 0;
  /** error/fatal mpv log lines seen since the current load began. mpv's
   *  `end-file` error carries only the generic `MPV_ERROR_*` string ("loading
   *  failed"); the real cause (TLS verify, HTTP status, unsupported codec) is in
   *  these log lines, so we buffer them and attach them to the error event. */
  private errorLog: string[] = [];

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
      // The app drives subtitle selection; don't let mpv auto-pick a track.
      '--sid=no',
      // The Fliks HLS references tokenised same-host segment/rendition URLs;
      // mpv's playlist safety check otherwise refuses them on the fallback path.
      '--load-unsafe-playlists=yes',
      '--ytdl=no',
      // Buffer like the web (Shaka) engine (~30s fwd / ~60s back / resume 1s).
      // cache-secs is the binding forward TIME cap — with --cache=yes it else
      // defaults to ~unlimited and overrides readahead-secs; bytes are a ceiling.
      '--cache=yes',
      '--cache-secs=30',
      '--demuxer-readahead-secs=30',
      '--demuxer-max-bytes=256MiB',
      '--demuxer-max-back-bytes=96MiB',
      '--cache-pause-wait=1',
      // A slow transcode (HDR tonemap re-encode) isn't ready when mpv opens
      // seg-0/init for a stream, so it aborts unless told to reconnect. A
      // separate multi-audio rendition's transcode spins up late and the open
      // can fail at the TRANSPORT layer (reset / refused / TLS) rather than with
      // a 4xx/5xx status, so reconnect_on_network_error is needed alongside
      // reconnect_on_http_error. The `4xx,5xx` value carries a comma, so it uses
      // mpv's `%len%` escaping (7 = strlen("4xx,5xx")) to survive the key-value-
      // list parser. Mirrors native/compositor/addon.cc.
      '--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_on_http_error=%7%4xx,5xx,reconnect_delay_max=5',
      `--input-ipc-server=${this.sockPath}`,
    ];
    console.log('[mpv] spawn:', this.mpvPath, args.join(' '));
    this.proc = spawn(this.mpvPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
    this.proc.on('exit', (code) => {
      this.emit('stateChanged', { state: 'idle' });
      this.emit('exit', { code });
      this.rejectAllPending('mpv process exited');
    });
    this.proc.stderr?.on('data', (d: Buffer) => this.emit('log', d.toString()));

    await this.connect();
    await this.setupObservers();
    // Surface mpv's own log over IPC (ffmpeg HTTP/TLS/decode failures) —
    // `--no-terminal` suppresses stderr, so this is how we see why a load
    // failed. Defaults to warn; FLIKS_MPV_LOGLEVEL=v exposes ffmpeg's per-open
    // 'Will reconnect' / HTTP-status lines for diagnosing segment failures.
    const logLevel = process.env.FLIKS_MPV_LOGLEVEL || 'warn';
    await this.command(['request_log_messages', logLevel]).catch(() => {});
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
        sock.on('error', (e) => {
          this.emit('error', { code: -1, message: String(e) });
          this.rejectAllPending(`mpv socket error: ${e}`);
        });
        sock.on('close', () => {
          this.sock = null;
          this.rejectAllPending('mpv socket closed');
        });
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
      case 'log-message': {
        const line = `${msg.prefix ? `${msg.prefix}: ` : ''}${msg.text ?? ''}`.trim();
        if (msg.level === 'error' || msg.level === 'fatal') {
          this.errorLog.push(line);
          if (this.errorLog.length > 12) this.errorLog.shift();
        }
        this.emit('log', `[${msg.level}] ${line}`);
        break;
      }
      case 'playback-restart':
        if (!this.sawFirstFrame) {
          this.sawFirstFrame = true;
          this.emit('firstFrame');
        }
        break;
      case 'end-file':
        if (msg.reason === 'eof') this.emit('stateChanged', { state: 'ended' });
        else if (msg.reason === 'error')
          this.emit('error', {
            code: -1,
            message: msg.file_error ?? 'end-file error',
            detail: this.errorLog.join(' | ') || undefined,
          });
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
        // mpv reports null for this between HLS segments; keep the last value
        // instead of zeroing it, otherwise the seekbar's buffered zone (drawn
        // `@if (bufferedEnd())`) collapses to 0 and flickers on every gap.
        if (data != null) this.cacheEnd = data;
        break;
      case 'eof-reached':
        // With `--keep-open=yes` this is how a natural end surfaces (no
        // `end-file`(eof)); map it to the `ended` state that drives auto-advance.
        if (data === true && !this.sawEof) {
          this.sawEof = true;
          this.emit('stateChanged', { state: 'ended' });
        }
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
      'eof-reached',
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
      try {
        this.sock.write(JSON.stringify({ command, request_id }) + '\n');
      } catch (e) {
        this.pending.delete(request_id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Fail every in-flight command so a socket/process death can't wedge an
   *  awaiting load/seek invoke forever. */
  private rejectAllPending(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
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
    this.sawEof = false;
    this.duration = 0;
    this.cacheEnd = 0;
    this.errorLog = [];
    const gen = ++this.loadGen;
    // Reset the reused player first so the new open's probe can't read atop the
    // previous file's buffered stream.
    await this.command(['stop']).catch(() => {});
    if (gen !== this.loadGen) return;
    // Always set http-header-fields (empty list when absent) so this reused
    // singleton can't inherit a prior load's auth header over the fresh ?token=.
    // A LIST property, not the loadfile options string (values carry ','/':' ).
    await this.set(
      'http-header-fields',
      opts.headers ? Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`) : [],
    );
    if (gen !== this.loadGen) return;
    // mpv >= 0.38 loadfile signature is <url> <flags> <index> <options>; the
    // bundled mpv is recent, so pass index 0 then the options. Omit the options
    // string when empty — mpv otherwise parses it as the index and rejects it.
    const fileOpts: string[] = [];
    if (opts.startTime && opts.startTime > 0) fileOpts.push(`start=${opts.startTime}`);
    // Force the HLS demuxer for manifests so mpv parses the playlist directly,
    // skipping the generic probe whose backward seek the linear HTTP stream
    // can't satisfy.
    this.forcedDemuxFormat = /\.m3u8(\?|$)/.test(opts.url) ? 'hls' : '';
    if (this.forcedDemuxFormat) fileOpts.push(`demuxer-lavf-format=${this.forcedDemuxFormat}`);
    const cmd: unknown[] = ['loadfile', opts.url, 'replace', 0];
    if (fileOpts.length) cmd.push(fileOpts.join(','));
    await this.command(cmd);
    if (gen !== this.loadGen) return;
    // The persistent mpv keeps its pause state across loads; force playback so a
    // freshly opened file always autoplays. The JS side treats this engine like
    // the mobile native player (playWhenReady) and never calls play() itself.
    await this.set('pause', false);
    if (gen !== this.loadGen) return;
    if (this.forcedDemuxFormat) {
      // The manifest is force-demuxed as hls (file-local). Once it has actually
      // opened, drop the forced format globally so a later sidecar sub-add isn't
      // demuxed as hls (which fails to open). Clearing it before the manifest
      // opens would race its own probe and break the load, so wait for the first
      // frame first.
      await this.waitFirstFrame(gen);
      if (gen !== this.loadGen) return;
      await this.command(['set', 'demuxer-lavf-format', '']).catch(() => {});
    }
    for (const s of opts.subtitles ?? []) {
      await this.command(['sub-add', s.url, 'auto', s.label ?? '', s.language ?? '']);
      if (gen !== this.loadGen) return;
    }
  }

  /** Resolve once mpv has opened the media (first frame), or on error/timeout.
   *  Lets load() sequence post-open work after the manifest demuxer is up. */
  private waitFirstFrame(gen: number): Promise<void> {
    if (this.sawFirstFrame || gen !== this.loadGen) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.off('firstFrame', done);
        this.off('error', done);
        resolve();
      };
      const timer = setTimeout(done, 10_000);
      this.once('firstFrame', done);
      this.once('error', done);
    });
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
    this.loadGen++;
    // Reset baselines so the persistent player can't replay a stale first-frame
    // / position into the next session after a back-navigation.
    this.sawFirstFrame = false;
    this.sawEof = false;
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
      else if (t.type === 'sub' && !isImageBasedSubtitleCodec(t.codec))
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

  /** Load a sidecar subtitle (mpv sub-add). `cached` makes mpv reuse an
   *  already-loaded track for the same URL instead of adding a duplicate, so
   *  re-selecting the same subtitle never stacks; mpv parses the VTT once and
   *  seeks within it natively, unlike a re-read HLS rendition. */
  async subAdd(url: string, label: string, language: string): Promise<void> {
    await this.command(['sub-add', url, 'cached', label ?? '', language ?? '']);
  }

  async setSubtitleStyle(s: DesktopSubtitleStyle): Promise<void> {
    for (const [name, value] of mpvSubtitleProps(s)) await this.set(name, value);
  }

  async destroy(): Promise<void> {
    this.loadGen++;
    try {
      // mpv may close the socket on quit without replying — cap the wait.
      await Promise.race([
        this.command(['quit']),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
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
