// libmpv control plane over mpv's JSON IPC socket.
//
// Transport + control only: video output / hardware decode / embedding args
// are injected as `baseArgs` by the platform embed backend, keeping this class
// OS-agnostic. The method surface mirrors the mobile `NativePlayer` contract.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
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
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';
import { mpvSubtitleProps } from './subtitle-style';
import { mapTrackList, type MpvTrack } from './tracks';
import { TypedEmitter } from './typed-emitter';
import type { PlayerBackend, PlayerBackendEvents } from './player-backend';

const CONNECT_RETRY_MS = 30;
const CONNECT_TIMEOUT_MS = 5000;
/** Cap on a single IPC command's round-trip. A live-but-wedged mpv would else
 *  hang an awaiting load/seek forever (only a socket/process death rejects). */
const COMMAND_TIMEOUT_MS = 30_000;
/** How long `load()` waits for the first frame before sequencing post-open work. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Grace for mpv to reply to `quit` before the socket/process are torn down. */
const QUIT_GRACE_MS = 500;
/** Ring size for buffered error/fatal log lines attached to an error event. */
const MAX_ERROR_LOG_LINES = 12;
/** Playhead-to-duration gap (s) above which an `eof-reached` is read as a
 *  mid-stream failure (ffmpeg surfaces a dead HLS segment as EOF, not an error)
 *  rather than a genuine end, and routed to `error` instead of `ended`. */
const PREMATURE_EOF_GAP_S = 10;

/** Monotonic per-process counter for the IPC socket/pipe name, so two players
 *  created within the same millisecond can't collide on the path. */
let instanceSeq = 0;

/** A message line from mpv's JSON IPC — either a command reply (`request_id`) or
 *  an event (`event`). Every field is optional; only the discriminant is read. */
interface MpvIpcMessage {
  request_id?: number;
  error?: string;
  data?: unknown;
  event?: string;
  name?: string;
  reason?: string;
  file_error?: string;
  level?: string;
  prefix?: string;
  text?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MpvPlayerOptions {
  /** Output / decode / embedding args from the platform backend (e.g. --wid, --vo). */
  baseArgs: string[];
  mpvPath?: string;
  /** Environment for the mpv process (e.g. X11-forced env from the backend). */
  env?: NodeJS.ProcessEnv;
}

export class MpvPlayer extends TypedEmitter<PlayerBackendEvents> implements PlayerBackend {
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
   *  set `eof-reached` instead of firing an `end-file`(eof) event, so the stream
   *  end is detected from that property. Guards against mpv re-sending the
   *  property-change so the end-vs-failure decision runs once. */
  private sawEof = false;
  private duration = 0;
  private cacheEnd = 0;
  /** Last `time-pos` seen; compared against `duration` when `eof-reached` fires
   *  to tell a genuine end from a mid-stream failure. */
  private lastPosition = 0;
  /** Set before an intentional shutdown (destroy / failed start) so the process
   *  `exit` handler can tell a clean quit from an unexpected crash. */
  private shuttingDown = false;
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
    const stamp = `fliks-mpv-${process.pid}-${instanceSeq++}-${Math.floor(performance.now())}`;
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
      // Buffering / reconnect tuning shared with the libmpv addons (see module).
      ...MPV_STREAM_OPTIONS.map(([name, value]) => `--${name}=${value}`),
      `--input-ipc-server=${this.sockPath}`,
    ];
    console.log('[mpv] spawn:', this.mpvPath, args.join(' '));
    this.proc = spawn(this.mpvPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      this.rejectAllPending('mpv process exited');
      if (this.shuttingDown) {
        this.emit('stateChanged', { state: 'idle' });
      } else {
        // Under --idle/--keep-open the process is persistent, so an exit we
        // didn't ask for is a crash (segfault / OOM-kill). Surface it as an
        // error with the buffered cause, not a benign idle.
        this.emit('error', {
          code: code ?? -1,
          message: `mpv exited unexpectedly (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
          detail: this.errorLog.join(' | ') || undefined,
        });
      }
    });
    this.proc.stderr?.on('data', (d: Buffer) => this.emit('log', d.toString()));

    try {
      await this.connect();
      await this.setupObservers();
      // Surface mpv's own log over IPC (ffmpeg HTTP/TLS/decode failures) —
      // `--no-terminal` suppresses stderr, so this is how we see why a load
      // failed. Defaults to verbose (matches the libmpv addons + docs), exposing
      // ffmpeg's per-open 'Will reconnect' / HTTP-status lines for diagnosing
      // segment failures; FLIKS_MPV_LOGLEVEL overrides it.
      const logLevel = process.env.FLIKS_MPV_LOGLEVEL || 'v';
      await this.command(['request_log_messages', logLevel]).catch(() => {});
    } catch (e) {
      // A failed connect/observe leaves the child alive; tear it down so it
      // can't orphan an embedded window.
      this.teardown();
      throw e;
    }
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
        // Drop the connect-phase rejecter so the live socket carries only the
        // permanent error handler installed below.
        sock.removeListener('error', reject);
        this.sock = sock;
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('error', (e) => {
          this.emit('error', {
            code: -1,
            message: String(e),
            detail: this.errorLog.join(' | ') || undefined,
          });
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
      let msg: MpvIpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id != null && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        clearTimeout(p.timer);
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
        else p.resolve(msg.data);
      } else if (msg.event) {
        this.onEvent(msg);
      }
    }
  }

  private onEvent(msg: MpvIpcMessage): void {
    switch (msg.event) {
      case 'property-change':
        this.onProperty(msg.name ?? '', msg.data);
        break;
      case 'log-message': {
        const line = `${msg.prefix ? `${msg.prefix}: ` : ''}${msg.text ?? ''}`.trim();
        if (msg.level === 'error' || msg.level === 'fatal') {
          this.errorLog.push(line);
          if (this.errorLog.length > MAX_ERROR_LOG_LINES) this.errorLog.shift();
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

  private onProperty(name: string, data: unknown): void {
    switch (name) {
      case 'time-pos':
        this.lastPosition = typeof data === 'number' ? data : 0;
        this.emit('timeUpdate', {
          position: this.lastPosition,
          duration: this.duration,
          buffered: this.cacheEnd,
        } satisfies DesktopPositionInfo);
        break;
      case 'duration':
        this.duration = typeof data === 'number' ? data : 0;
        break;
      case 'demuxer-cache-time':
        // mpv reports null for this between HLS segments; keep the last value
        // instead of zeroing it, otherwise the seekbar's buffered zone (drawn
        // `@if (bufferedEnd())`) collapses to 0 and flickers on every gap.
        if (typeof data === 'number') this.cacheEnd = data;
        break;
      case 'eof-reached':
        // mpv sets `eof-reached` at a genuine end (surfaced here since
        // `--keep-open=yes` suppresses `end-file`(eof)) but ALSO when playback
        // can't continue: ffmpeg's HLS demuxer reports a segment that failed
        // past its reconnect budget as EOF, not an error. Discriminate by the
        // playhead — a real end sits at the duration; a premature stop is short
        // by more than a segment (or, with an unknown duration, coincides with
        // buffered errors) — and route the premature case to `error` (with the
        // buffered cause) so it recovers or shows why, not silently advances.
        // mpv clears the flag on a backward seek, so reset the one-shot then.
        if (data === true && !this.sawEof) {
          this.sawEof = true;
          const premature =
            this.duration > 0
              ? this.duration - this.lastPosition > PREMATURE_EOF_GAP_S
              : this.errorLog.length > 0;
          if (premature) {
            this.emit('error', {
              code: -1,
              message: 'playback stopped before end of stream',
              detail: this.errorLog.join(' | ') || undefined,
            });
          } else {
            this.emit('stateChanged', { state: 'ended' });
          }
        } else if (data === false) {
          this.sawEof = false;
        }
        break;
      case 'pause':
        this.emit('stateChanged', { state: data ? 'paused' : 'playing' });
        break;
      case 'paused-for-cache':
        if (data) this.emit('stateChanged', { state: 'buffering' });
        break;
      case 'track-list':
        this.emit('tracksChanged', mapTrackList((data as MpvTrack[]) ?? []));
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

  private command<T = unknown>(command: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.sock) return reject(new Error('mpv socket not connected'));
      const request_id = ++this.reqId;
      const timer = setTimeout(() => {
        if (this.pending.delete(request_id)) {
          reject(new Error(`mpv command timed out: ${JSON.stringify(command)}`));
        }
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(request_id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.sock.write(JSON.stringify({ command, request_id }) + '\n');
      } catch (e) {
        this.pending.delete(request_id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Fail every in-flight command so a socket/process death can't wedge an
   *  awaiting load/seek invoke forever. */
  private rejectAllPending(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }

  private get<T = unknown>(prop: string): Promise<T> {
    return this.command<T>(['get_property', prop]);
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
    this.lastPosition = 0;
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
      if (gen !== this.loadGen) return;
      // Best-effort: this runs after the video is playing, so an unreachable
      // sidecar subtitle must not reject the load.
      await this.command(['sub-add', s.url, 'auto', s.label ?? '', s.language ?? '']).catch((e) =>
        this.emit('log', `[warn] sub-add failed ${s.url}: ${e}`),
      );
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
      const timer = setTimeout(done, FIRST_FRAME_TIMEOUT_MS);
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
    this.lastPosition = 0;
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
    // The observed properties are the single source of truth (buffered keeps its
    // last non-null value across HLS gaps); re-reading them live would race that
    // and report buffered:0 mid-gap.
    return { position: this.lastPosition, duration: this.duration, buffered: this.cacheEnd };
  }

  async getAudioTracks(): Promise<DesktopAudioTrack[]> {
    return mapTrackList((await this.get<MpvTrack[]>('track-list')) ?? []).audioTracks;
  }

  selectAudioTrack(id: string): Promise<void> {
    return this.set('aid', id);
  }

  async getSubtitleTracks(): Promise<DesktopSubtitleTrack[]> {
    return mapTrackList((await this.get<MpvTrack[]>('track-list')) ?? []).subtitleTracks;
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

  /** Tear down the socket + process + IPC path. Idempotent; also marks the exit
   *  as intentional so the `exit` handler reports idle, not a crash. */
  private teardown(): void {
    this.shuttingDown = true;
    this.sock?.destroy();
    this.sock = null;
    this.proc?.kill('SIGTERM');
    try {
      if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
    } catch {
      /* best effort; a Windows named pipe is never a filesystem entry */
    }
  }

  async destroy(): Promise<void> {
    this.loadGen++;
    this.shuttingDown = true;
    try {
      // mpv may close the socket on quit without replying — cap the wait.
      await Promise.race([
        this.command(['quit']),
        new Promise<void>((resolve) => setTimeout(resolve, QUIT_GRACE_MS)),
      ]);
    } catch {
      /* socket may already be gone */
    }
    this.teardown();
  }
}
