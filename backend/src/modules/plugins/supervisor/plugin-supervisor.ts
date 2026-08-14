import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server, type Socket } from 'net';
import { randomBytes } from 'crypto';
import { chmodSync, chownSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginsSocketDir } from '../../../common/constants/paths';
import type { OnApplicationShutdown } from '@nestjs/common';
import { LogBufferService } from '../../scheduler/log-buffer.service';
import { CURRENT_FLIKS_VERSION } from '../plugin-version';
import type { PluginApi } from '../../../common/plugin-contract';

type HelloReply = Awaited<ReturnType<PluginApi['hello']>>;
import { PLUGIN_API_VERSION, type Note, type PluginHostApi } from '../../../common/plugin-contract';
import { RpcChannel } from './rpc-channel';
import { NoteRingBuffer } from './note-ring-buffer';
import {
  buildSpawnPlan,
  prepareDirForDroppedChild,
  shouldDropPrivileges,
  PLUGIN_CHILD_UID,
  PLUGIN_CHILD_GID,
} from './spawn-plan';
import { writePidFile, removePidFile } from './pid-file';

export type SupervisorState =
  | 'stopped'
  | 'starting'
  | 'handshaking'
  | 'ready'
  | 'degraded'
  | 'crashed'
  | 'backoff'
  | 'failed';

const STDERR_TAIL_BYTES = 4 * 1024;

/**
 * Host methods whose own work is not a lookup. `library.ingest` copies the release into the
 * library and probes it: one 2160p file blew straight past the 8 s default in production, and the
 * deadline only abandons the wait — core finished the copy, so the plugin recorded a failure for
 * an import that had landed.
 */
const HOST_CALL_DEADLINE_OVERRIDES_MS: Readonly<Record<string, number>> = {
  'library.ingest': 30 * 60_000,
};

/** `WARN` as the line's own level — after any bracketed prefixes, never inside the message. */
const SELF_DECLARED_WARN = /^(?:\[[^\]]*\]\s*)*WARN\b/;

/** Every figure here is "The spawn call and the supervisor"'s, verbatim. Override only in tests. */
export const DEFAULT_SUPERVISOR_OPTIONS = {
  memoryMb: 256,
  handshakeDeadlineMs: 10_000,
  healthIntervalMs: 15_000,
  healthDeadlineMs: 3_000,
  backoffLadderMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  readyResetMs: 120_000,
  breakerWindowMs: 10 * 60_000,
  breakerMaxCrashes: 6,
  shutdownRpcDeadlineMs: 3_000,
  sigtermGraceMs: 2_000,
  logCapBytesPerMinute: 64 * 1024,
  hostCallTimeoutMs: 8_000,
};

export interface PluginSupervisorOptions {
  id: string;
  /** Directory already holding a materialized `plugin.js` (extraction is out of this PR's scope). */
  dir: string;
  /** Where the sockets and pid file live. Defaults to the `fliks-rt` directory,
   *  outside the tree holding plugin content. */
  runtimeDir?: string;
  logBuffer: LogBufferService;
  dbUrl?: string;
  config?: Record<string, string>;
  memoryMb?: number;
  handshakeDeadlineMs?: number;
  healthIntervalMs?: number;
  healthDeadlineMs?: number;
  backoffLadderMs?: number[];
  readyResetMs?: number;
  breakerWindowMs?: number;
  breakerMaxCrashes?: number;
  shutdownRpcDeadlineMs?: number;
  sigtermGraceMs?: number;
  logCapBytesPerMinute?: number;
  /** Ceiling on one inbound host call's own runtime, separate from the caller's 10s socket timeout. */
  hostCallTimeoutMs?: number;
  /** Bound to `id` above at construction via `PluginHostBindingService.bind` —
   *  dispatch never re-derives identity from an inbound frame. `null` leaves core calls unanswered. */
  hostApi?: PluginHostApi | null;
}

/** Rejects once `ms` elapses, whichever of `promise` or the timer settles first;
 *  always clears the timer so a fast call never leaves one dangling. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host method "${label}" timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** A plugin id is dotted, and a dot is a regex metacharacter. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 0600 keeps a second plugin out; the chown is what lets the dropped child in at all. */
function listenAndRestrict(server: Server, path: string, dropTo: { uid: number; gid: number } | null): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      if (dropTo) chownSync(path, dropTo.uid, dropTo.gid);
      resolve();
    });
  });
}

/**
 * Owns one `process`-tier plugin's lifecycle end to end. Core listens on both
 * sockets; the plugin dials out — `coreSock` for its 15 host calls, `pluginSock` for the core-initiated ones.
 */
export class PluginSupervisor implements OnApplicationShutdown {
  private readonly opts: Required<PluginSupervisorOptions>;
  private readonly coreSockPath: string;
  private readonly pluginSockPath: string;

  private state: SupervisorState = 'stopped';
  private stateListeners: ((s: SupervisorState) => void)[] = [];

  private coreServer: Server | null = null;
  private pluginServer: Server | null = null;
  private pluginChannel: RpcChannel | null = null;
  private pluginSocketRef: Socket | null = null;

  private child: ChildProcess | null = null;
  private token = '';
  private stopRequested = false;
  private crashHandledForThisChild = false;

  private handshakeTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private backoffTimer: NodeJS.Timeout | null = null;
  private readyResetTimer: NodeJS.Timeout | null = null;

  private consecutiveHealthMisses = 0;
  private healthCheckCount = 0;
  private backoffIndex = 0;
  private crashTimestamps: number[] = [];
  private totalCrashes = 0;
  private stderrTail = '';
  private statusMessage = '';
  private lastExitSignal: NodeJS.Signals | null = null;

  private readonly ring = new NoteRingBuffer();
  private ringBackpressured = false;

  private logWindowStart = Date.now();
  private logBytesThisMinute = 0;
  private logSuppressedThisWindow = false;

  constructor(options: PluginSupervisorOptions) {
    // Sockets and pid files default out of the directory holding plugin content,
    // so sweeping installed files can never unlink a live channel.
    this.opts = {
      ...DEFAULT_SUPERVISOR_OPTIONS,
      dbUrl: '',
      config: {},
      runtimeDir: getPluginsSocketDir(),
      hostApi: null,
      ...options,
    };
    // Random suffix: another plugin (same uid, same runtime dir) can't derive this path from the id alone.
    const rand = randomBytes(8).toString('hex');
    this.coreSockPath = join(this.opts.runtimeDir, `${this.opts.id}.${rand}.core.sock`);
    this.pluginSockPath = join(this.opts.runtimeDir, `${this.opts.id}.${rand}.plugin.sock`);
  }

  getState(): SupervisorState {
    return this.state;
  }
  getEventDropCount(): number {
    return this.ring.dropped;
  }
  getRingSize(): number {
    return this.ring.size;
  }
  getRestartCount(): number {
    return this.totalCrashes;
  }
  getBackoffIndex(): number {
    return this.backoffIndex;
  }
  getHealthCheckCount(): number {
    return this.healthCheckCount;
  }
  getStderrTail(): string {
    return this.stderrTail;
  }
  getStatusMessage(): string {
    return this.statusMessage;
  }
  /** For tests: proves which branch of a kill ladder actually fired. */
  getLastExitSignal(): NodeJS.Signals | null {
    return this.lastExitSignal;
  }
  getSocketPaths(): { coreSockPath: string; pluginSockPath: string } {
    return { coreSockPath: this.coreSockPath, pluginSockPath: this.pluginSockPath };
  }

  /** Thin public wrapper around the private RPC channel, for the HTTP proxy. Rejects
   *  immediately rather than queuing when the plugin isn't `ready` to answer a call. */
  callPlugin<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.state !== 'ready' || !this.pluginChannel) {
      return Promise.reject(new Error(`plugin "${this.opts.id}" is not ready (state: ${this.state})`));
    }
    return this.pluginChannel.call<T>(method, params, timeoutMs);
  }

  onStateChange(cb: (s: SupervisorState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== cb);
    };
  }

  /** Non-null only when the child will run as another uid, which is the only case needing a chown. */
  private dropTarget(): { uid: number; gid: number } | null {
    return shouldDropPrivileges(process.platform, process.getuid?.bind(process))
      ? { uid: PLUGIN_CHILD_UID, gid: PLUGIN_CHILD_GID }
      : null;
  }

  private setState(s: SupervisorState): void {
    this.state = s;
    for (const cb of this.stateListeners) cb(s);
  }

  /** Fire-and-forget, at-most-once. Queues through the 64-entry ring on backpressure. */
  emitEvent(name: string, payload: unknown): void {
    this.ring.push({ m: 'event', p: { name, payload } });
    this.flushRing();
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.stopRequested = false;
    await this.setupSockets();
    await this.spawnChild();
  }

  /** Clears the circuit breaker after a manual re-enable. Required before `start()` works again from `failed`. */
  reEnable(): void {
    if (this.state !== 'failed') return;
    this.crashTimestamps = [];
    this.backoffIndex = 0;
    this.setState('stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** `shutdown` RPC -> 3s -> SIGTERM -> 2s -> SIGKILL -> unlink both sockets. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearAllTimers();

    if (this.child && !this.child.killed) {
      if (this.pluginChannel) {
        try {
          await this.pluginChannel.call('shutdown', {}, this.opts.shutdownRpcDeadlineMs);
          const exited = await this.waitForExit(this.opts.sigtermGraceMs);
          if (!exited) await this.killLadder();
        } catch {
          await this.killLadder();
        }
      } else {
        await this.killLadder();
      }
    }

    this.setState('stopped');
    this.cleanupSockets();
  }

  private async killLadder(): Promise<void> {
    if (!this.child || this.child.killed) return;
    this.child.kill('SIGTERM');
    const exited = await this.waitForExit(this.opts.sigtermGraceMs);
    if (!exited) {
      this.child.kill('SIGKILL');
      await this.waitForExit(2_000);
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child) return Promise.resolve(true);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child!.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private cleanupSockets(): void {
    this.coreServer?.close();
    this.pluginServer?.close();
    for (const p of [this.coreSockPath, this.pluginSockPath]) {
      try {
        unlinkSync(p);
      } catch {
        // never listened, or already gone
      }
    }
    removePidFile(this.opts.runtimeDir, this.opts.id);
  }

  private async setupSockets(): Promise<void> {
    mkdirSync(this.opts.runtimeDir, { recursive: true });
    const dropTo = this.dropTarget();
    try {
      // 0710: owner lists it, a dropped child's group traverses to a known socket path but cannot readdir.
      chmodSync(this.opts.runtimeDir, 0o710);
      if (dropTo) chownSync(this.opts.runtimeDir, -1, dropTo.gid);
    } catch (err) {
      this.opts.logBuffer.warn(
        `could not harden runtime dir permissions: ${(err as Error).message}`,
        `plugin:${this.opts.id}`,
      );
    }
    // A random name is never reused, so this plugin's own sockets from earlier runs would
    // accumulate for ever; only its own are touched, and it is about to own them anyway.
    const stale = new RegExp(`^${escapeForRegExp(this.opts.id)}\\.[0-9a-f]{16}\\.(?:core|plugin)\\.sock$`);
    for (const name of readdirSync(this.opts.runtimeDir)) {
      if (!stale.test(name)) continue;
      try {
        unlinkSync(join(this.opts.runtimeDir, name));
      } catch {
        // nothing stale to remove
      }
    }
    this.coreServer = createServer((s) => this.onCoreConnected(s));
    this.pluginServer = createServer((s) => {
      if (this.pluginChannel) {
        s.destroy();
        return;
      }
      this.onPluginConnected(s);
    });
    await Promise.all([
      listenAndRestrict(this.coreServer, this.coreSockPath, dropTo),
      listenAndRestrict(this.pluginServer, this.pluginSockPath, dropTo),
    ]);
  }

  private onCoreConnected(socket: Socket): void {
    // Plugin's uplink for the 15 host methods.
    const channel = new RpcChannel(socket);
    channel.onViolation((err) => this.onViolation(err));
    channel.onRequest((method, payload) => this.dispatchHostCall(method, payload));
  }

  /** `hostApi` is fixed at construction to `this.opts.id` — nothing in `payload` can
   *  select another plugin's identity. An unknown method or a call past
   *  `hostCallTimeoutMs` both reject, so `RpcChannel` answers with an error frame
   *  instead of leaving the plugin's own 10s client to time out. */
  private dispatchHostCall(method: string, payload: unknown): Promise<unknown> {
    const api = this.opts.hostApi as Record<string, (p: unknown) => Promise<unknown>> | null;
    const fn = api?.[method];
    if (!fn) return Promise.reject(new Error(`unknown host method "${method}"`));
    // Promise.resolve().then(...) folds a synchronous throw from `fn` into the same
    // rejection path as an async one, so both answer with an error frame, never crash.
    const deadlineMs = HOST_CALL_DEADLINE_OVERRIDES_MS[method] ?? this.opts.hostCallTimeoutMs;
    return withDeadline(Promise.resolve().then(() => fn(payload)), deadlineMs, method);
  }

  private onPluginConnected(socket: Socket): void {
    this.pluginSocketRef = socket;
    const channel = new RpcChannel(socket);
    channel.onViolation((err) => this.onViolation(err));
    channel.onNoteDropped((note, err) => {
      this.ring.countDrop();
      this.opts.logBuffer.warn(`dropped note "${note.m}": ${err.message}`, `plugin:${this.opts.id}`);
    });
    this.pluginChannel = channel;
    void this.attemptHandshake(channel);
  }

  private onViolation(err: Error): void {
    this.opts.logBuffer.warn(`protocol violation: ${err.message}`, `plugin:${this.opts.id}`);
    this.handleCrash(`protocol violation: ${err.message}`);
  }

  private async spawnChild(): Promise<void> {
    this.pluginChannel = null;
    this.pluginSocketRef = null;
    this.crashHandledForThisChild = false;
    this.lastExitSignal = null;

    this.setState('starting');
    const dropTo = this.dropTarget();
    if (dropTo) prepareDirForDroppedChild(this.opts.dir, dropTo.uid, dropTo.gid);
    else mkdirSync(join(this.opts.dir, 'data'), { recursive: true });
    this.token = randomBytes(32).toString('hex');

    const plan = buildSpawnPlan({
      dir: this.opts.dir,
      memoryMb: this.opts.memoryMb,
      coreSockPath: this.coreSockPath,
      pluginSockPath: this.pluginSockPath,
      token: this.token,
      pluginId: this.opts.id,
      dbUrl: this.opts.dbUrl,
      config: this.opts.config,
    });

    // An exec that never happened surfaces either way: asynchronously as 'error', or synchronously
    // from `spawn` itself when the uid drop is refused. Both are crashes, never an uncaught throw.
    try {
      this.child = spawn(plan.command, plan.args, plan.options);
    } catch (err) {
      this.child = null;
      this.handleCrash(`failed to spawn: ${(err as Error).message}`);
      return;
    }
    this.child.on('error', (err) => this.handleCrash(`failed to spawn: ${err.message}`));
    const pid = this.child.pid;
    if (pid !== undefined) writePidFile(this.opts.runtimeDir, this.opts.id, pid, plan.expectedCmdline);
    this.wireChildIo(this.child);
    this.child.on('exit', (code, signal) => this.onChildExit(code, signal));

    this.setState('handshaking');
    this.handshakeTimer = setTimeout(() => this.handleCrash('handshake timeout'), this.opts.handshakeDeadlineMs);
  }

  private wireChildIo(child: ChildProcess): void {
    const tag = `plugin:${this.opts.id}`;
    const onChunk = (level: 'log' | 'error', chunk: Buffer) => {
      const now = Date.now();
      if (now - this.logWindowStart >= 60_000) {
        this.logWindowStart = now;
        this.logBytesThisMinute = 0;
        this.logSuppressedThisWindow = false;
      }
      const text = chunk.toString('utf8');
      this.logBytesThisMinute += Buffer.byteLength(text);
      if (this.logBytesThisMinute > this.opts.logCapBytesPerMinute) {
        if (!this.logSuppressedThisWindow) {
          this.logSuppressedThisWindow = true;
          this.opts.logBuffer.warn(
            `output suppressed — exceeded ${this.opts.logCapBytesPerMinute} B/min`,
            tag,
          );
        }
        return;
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        if (level === 'log') this.opts.logBuffer.log(line, tag);
        else {
          // A plugin that names its own level keeps it: everything it writes to stderr,
          // warnings included, would otherwise paint the core log as errors.
          if (SELF_DECLARED_WARN.test(line)) this.opts.logBuffer.warn(line, tag);
          else this.opts.logBuffer.error(line, undefined, tag);
          this.stderrTail = (this.stderrTail + line + '\n').slice(-STDERR_TAIL_BYTES);
        }
      }
    };
    child.stdout?.on('data', (b: Buffer) => onChunk('log', b));
    child.stderr?.on('data', (b: Buffer) => onChunk('error', b));
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.lastExitSignal = signal;
    if (this.pluginChannel) {
      this.pluginChannel.destroy();
      this.pluginChannel = null;
    }
    if (this.stopRequested) return; // stop() owns the transition out of a deliberate shutdown
    this.handleCrash(`exited unexpectedly (code=${code}, signal=${signal})`);
  }

  private async attemptHandshake(channel: RpcChannel): Promise<void> {
    try {
      const res = await channel.call<HelloReply>(
        'hello',
        { pluginApi: PLUGIN_API_VERSION, coreVersion: CURRENT_FLIKS_VERSION, config: this.opts.config },
        this.opts.handshakeDeadlineMs,
      );
      // The token never travels core->plugin; only a process holding the real FLIKS_PLUGIN_TOKEN
      // can echo it back. Annotated, so loosening the contract's `token` stops compiling here.
      const echoed: string = res.token;
      if (echoed !== this.token) {
        this.handleCrash('hello token mismatch');
        return;
      }
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.enterReady();
      this.startHealthLoop();
      this.flushRing();
    } catch (err) {
      this.handleCrash(`handshake failed: ${(err as Error).message}`);
    }
  }

  private enterReady(): void {
    this.setState('ready');
    this.clearReadyResetTimer();
    // Resets the backoff ladder only after this much continuous ready time —
    // a plugin crashing just before the window elapses must not restart at 1s forever.
    this.readyResetTimer = setTimeout(() => {
      this.backoffIndex = 0;
    }, this.opts.readyResetMs);
  }

  private clearReadyResetTimer(): void {
    if (this.readyResetTimer) {
      clearTimeout(this.readyResetTimer);
      this.readyResetTimer = null;
    }
  }

  private startHealthLoop(): void {
    this.consecutiveHealthMisses = 0;
    this.healthTimer = setInterval(() => void this.performHealthCheck(), this.opts.healthIntervalMs);
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.pluginChannel) return;
    this.healthCheckCount++;
    try {
      await this.pluginChannel.call('health', {}, this.opts.healthDeadlineMs);
      this.consecutiveHealthMisses = 0;
      if (this.state === 'degraded') this.enterReady();
    } catch {
      this.consecutiveHealthMisses++;
      if (this.consecutiveHealthMisses === 2 && this.state === 'ready') {
        this.setState('degraded');
        this.clearReadyResetTimer();
      }
      if (this.consecutiveHealthMisses >= 4) {
        if (this.healthTimer) {
          clearInterval(this.healthTimer);
          this.healthTimer = null;
        }
        await this.forceKillForHealthFailure();
      }
    }
  }

  private async forceKillForHealthFailure(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      const exited = await this.waitForExit(this.opts.sigtermGraceMs);
      if (!exited) {
        this.child.kill('SIGKILL');
        await this.waitForExit(2_000);
      }
    }
    this.handleCrash('health check missed 4 times');
  }

  /** Every crash path funnels here — idempotent per spawned child so a kill plus its own exit event can't double-count. */
  private handleCrash(reason: string): void {
    if (this.crashHandledForThisChild) return;
    this.crashHandledForThisChild = true;
    this.clearAllTimers();
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    this.pluginChannel?.destroy();
    this.pluginChannel = null;
    this.ringBackpressured = false; // the 'drain' listener that would clear it died with the socket

    this.setState('crashed');
    this.totalCrashes++;
    const now = Date.now();
    this.crashTimestamps.push(now);
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < this.opts.breakerWindowMs);

    if (this.crashTimestamps.length >= this.opts.breakerMaxCrashes) {
      this.statusMessage = this.stderrTail;
      this.opts.logBuffer.error(
        `circuit breaker tripped after ${this.crashTimestamps.length} crashes in the last ` +
          `${this.opts.breakerWindowMs}ms (${reason}); manual re-enable required`,
        undefined,
        `plugin:${this.opts.id}`,
      );
      this.setState('failed');
      return;
    }
    this.opts.logBuffer.warn(`plugin crashed: ${reason}`, `plugin:${this.opts.id}`);

    const delay = this.opts.backoffLadderMs[Math.min(this.backoffIndex, this.opts.backoffLadderMs.length - 1)];
    this.backoffIndex++;
    this.setState('backoff');
    this.backoffTimer = setTimeout(() => void this.spawnChild(), delay);
  }

  private clearAllTimers(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.clearReadyResetTimer();
  }

  private flushRing(): void {
    if (!this.pluginChannel) return;
    while (!this.ringBackpressured && this.ring.size > 0) {
      const note = this.ring.shift() as Note;
      const ok = this.pluginChannel.sendNote(note);
      if (!ok) {
        this.ringBackpressured = true;
        this.pluginSocketRef?.once('drain', () => {
          this.ringBackpressured = false;
          this.flushRing();
        });
      }
    }
  }
}
