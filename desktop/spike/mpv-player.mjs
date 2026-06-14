// Spike: libmpv control plane over mpv's JSON IPC socket.
//
// Proves the desktop playback control surface headlessly, before wiring it
// to Electron. The method surface intentionally mirrors the mobile
// `NativePlayer` Capacitor plugin contract (create/load/play/pause/seek/stop,
// audio + subtitle track listing/selection, subtitle styling, position),
// so the production `DesktopEngine` can be a near-copy of `native-engine.ts`.
//
// Transport: mpv runs with `--input-ipc-server=<unix socket>`; commands are
// newline-delimited JSON with a `request_id` correlated to the reply, and mpv
// pushes `event` / `property-change` frames we surface as engine events.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CONNECT_RETRY_MS = 30;
const CONNECT_TIMEOUT_MS = 5000;

export class MpvPlayer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.mpvPath]   path to the (vendored) mpv binary
   * @param {boolean} [opts.headless] vo=null/ao=null — for tests, no window
   * @param {number}  [opts.wid]      native window id to embed into (--wid)
   * @param {boolean} [opts.hdr]      enable HDR passthrough hint (gpu-next)
   */
  constructor(opts = {}) {
    super();
    this._mpvPath = opts.mpvPath ?? 'mpv';
    this._headless = !!opts.headless;
    this._wid = opts.wid;
    this._hdr = opts.hdr ?? true;
    /** @type {import('node:child_process').ChildProcess | null} */
    this._proc = null;
    /** @type {net.Socket | null} */
    this._sock = null;
    this._sockPath = path.join(
      os.tmpdir(),
      `fliks-mpv-${process.pid}-${Math.floor(performance.now())}.sock`,
    );
    this._reqId = 0;
    /** @type {Map<number, {resolve:Function, reject:Function}>} */
    this._pending = new Map();
    this._buf = '';
    this._observeId = 0;
    this._sawFirstFrame = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Spawn mpv idle and connect to its IPC socket. */
  async start() {
    const args = [
      '--idle=yes',
      '--no-config',
      '--no-terminal',
      '--keep-open=yes', // hold the last frame on EOF instead of quitting
      `--input-ipc-server=${this._sockPath}`,
    ];
    if (this._headless) {
      args.push('--vo=null', '--ao=null');
    } else {
      // Hardware decode + HDR passthrough. gpu-next + colorspace hint pass
      // HDR10/DV metadata to the display on macOS (EDR) / Windows (D3D11).
      args.push('--vo=gpu-next', '--hwdec=auto-safe');
      if (this._hdr) args.push('--target-colorspace-hint=yes');
      if (this._wid != null) args.push(`--wid=${this._wid}`);
    }

    this._proc = spawn(this._mpvPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc.on('exit', (code) => {
      this.emit('stateChanged', { state: 'idle' });
      this.emit('exit', { code });
    });
    this._proc.stderr?.on('data', (d) => this.emit('log', String(d)));

    await this._connect();
    await this._setupObservers();
    return this;
  }

  async _connect() {
    const deadline = performance.now() + CONNECT_TIMEOUT_MS;
    for (;;) {
      if (fs.existsSync(this._sockPath)) {
        try {
          await this._open();
          return;
        } catch {
          /* socket file exists but not accepting yet — retry */
        }
      }
      if (performance.now() > deadline) {
        throw new Error(`mpv IPC socket never appeared at ${this._sockPath}`);
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }

  _open() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this._sockPath);
      sock.once('connect', () => {
        this._sock = sock;
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('error', (e) => this.emit('error', { code: -1, message: String(e) }));
        resolve();
      });
      sock.once('error', reject);
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id != null && this._pending.has(msg.request_id)) {
        const { resolve, reject } = this._pending.get(msg.request_id);
        this._pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
        else resolve(msg.data);
      } else if (msg.event) {
        this._onEvent(msg);
      }
    }
  }

  _onEvent(msg) {
    switch (msg.event) {
      case 'property-change':
        this._onProperty(msg.name, msg.data);
        break;
      case 'playback-restart':
        if (!this._sawFirstFrame) {
          this._sawFirstFrame = true;
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

  _onProperty(name, data) {
    switch (name) {
      case 'time-pos':
        this._time = data ?? 0;
        this.emit('timeUpdate', {
          position: this._time,
          duration: this._duration ?? 0,
          buffered: this._cacheEnd ?? 0,
        });
        break;
      case 'duration':
        this._duration = data ?? 0;
        break;
      case 'demuxer-cache-time':
        this._cacheEnd = data ?? 0;
        break;
      case 'pause':
        this.emit('stateChanged', { state: data ? 'paused' : 'playing' });
        break;
      case 'paused-for-cache':
        if (data) this.emit('stateChanged', { state: 'buffering' });
        break;
      case 'track-list':
        this.emit('tracksChanged', this._mapTracks(data ?? []));
        break;
      default:
        break;
    }
  }

  async _setupObservers() {
    for (const prop of [
      'time-pos',
      'duration',
      'demuxer-cache-time',
      'pause',
      'paused-for-cache',
      'track-list',
    ]) {
      await this._command(['observe_property', ++this._observeId, prop]);
    }
  }

  // ── Command transport ──────────────────────────────────────────────────

  _command(command) {
    return new Promise((resolve, reject) => {
      if (!this._sock) return reject(new Error('mpv socket not connected'));
      const request_id = ++this._reqId;
      this._pending.set(request_id, { resolve, reject });
      this._sock.write(JSON.stringify({ command, request_id }) + '\n');
    });
  }

  _get(prop) {
    return this._command(['get_property', prop]);
  }

  _set(prop, value) {
    return this._command(['set_property', prop, value]);
  }

  // ── NativePlayer-equivalent surface ──────────────────────────────────────

  /**
   * @param {object} o
   * @param {string} o.url
   * @param {number} [o.startTime]   seconds
   * @param {Record<string,string>} [o.headers]
   * @param {{url:string,language:string,label:string}[]} [o.subtitles]
   */
  async load({ url, startTime = 0, headers, subtitles = [] }) {
    this._sawFirstFrame = false;
    const opts = [];
    if (startTime > 0) opts.push(`start=+${startTime}`);
    if (headers && Object.keys(headers).length) {
      const fields = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join(',');
      opts.push(`http-header-fields=${fields}`);
    }
    await this._command(['loadfile', url, 'replace', opts.join(',')]);
    for (const s of subtitles) {
      await this._command(['sub-add', s.url, 'auto', s.label ?? '', s.language ?? '']);
    }
  }

  play() {
    return this._set('pause', false);
  }

  pause() {
    return this._set('pause', true);
  }

  seek(position) {
    return this._command(['seek', position, 'absolute']);
  }

  stop() {
    return this._command(['stop']);
  }

  setPlaybackRate(rate) {
    return this._set('speed', rate);
  }

  async getPosition() {
    return {
      position: (await this._get('time-pos').catch(() => 0)) ?? 0,
      duration: (await this._get('duration').catch(() => 0)) ?? 0,
      buffered: (await this._get('demuxer-cache-time').catch(() => 0)) ?? 0,
    };
  }

  _mapTracks(list) {
    const audio = [];
    const subtitle = [];
    for (const t of list) {
      if (t.type === 'audio')
        audio.push({ id: String(t.id), language: t.lang ?? '', label: t.title ?? '', selected: !!t.selected });
      else if (t.type === 'sub')
        subtitle.push({
          id: String(t.id),
          language: t.lang ?? '',
          label: t.title ?? '',
          forced: !!t.forced,
          selected: !!t.selected,
        });
    }
    return { audioTracks: audio, subtitleTracks: subtitle };
  }

  async getAudioTracks() {
    return this._mapTracks((await this._get('track-list')) ?? []).audioTracks;
  }

  selectAudioTrack(id) {
    return this._set('aid', id);
  }

  async getSubtitleTracks() {
    return this._mapTracks((await this._get('track-list')) ?? []).subtitleTracks;
  }

  selectSubtitleTrack(id) {
    return this._set('sid', id == null ? 'no' : id);
  }

  /**
   * @param {object} s
   * @param {number} s.fontScale        relative to mpv default
   * @param {string} s.foregroundColor  #RRGGBB
   * @param {string} s.backgroundColor  #RRGGBB or 'transparent'
   * @param {number} s.bottomMarginPercent
   */
  async setSubtitleStyle(s) {
    await this._set('sub-font-size', Math.round(55 * (s.fontScale ?? 1)));
    if (s.foregroundColor) await this._set('sub-color', s.foregroundColor);
    if (s.backgroundColor && s.backgroundColor !== 'transparent') {
      await this._set('sub-back-color', s.backgroundColor);
      await this._set('sub-border-style', 'background-box');
    }
    if (s.bottomMarginPercent != null) await this._set('sub-pos', 100 - s.bottomMarginPercent);
  }

  async destroy() {
    try {
      await this._command(['quit']);
    } catch {
      /* socket may already be gone */
    }
    this._sock?.destroy();
    this._proc?.kill('SIGTERM');
    try {
      fs.existsSync(this._sockPath) && fs.unlinkSync(this._sockPath);
    } catch {
      /* best effort */
    }
  }
}
