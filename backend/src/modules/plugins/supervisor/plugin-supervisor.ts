import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server, type Socket } from 'net';
import { randomBytes } from 'crypto';
import { chmodSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginsSocketDir } from '../../../common/constants/paths';
import type { OnApplicationShutdown } from '@nestjs/common';
import { LogBufferService } from '../../scheduler/log-buffer.service';
import { CURRENT_FLIKS_VERSION } from '../plugin-registry.service';
import { PLUGIN_API_VERSION, type Note } from '../../../common/plugin-contract';
import { RpcChannel } from './rpc-channel';
import { NoteRingBuffer } from './note-ring-buffer';
import { buildSpawnPlan } from './spawn-plan';
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
}

function listenAndChmod(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve();
    });
  });
}

/**
 * Owns one `process`-tier plugin's lifecycle end to end. Core listens on both
 * sockets; the plugin dials out — `coreSock` for its 17 calls (unhandled here), `pluginSock` for the 7 core-initiated ones.
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
      ...options,
    };
    this.coreSockPath = join(this.opts.runtimeDir, `${this.opts.id}.core.sock`);
    this.pluginSockPath = join(this.opts.runtimeDir, `${this.opts.id}.plugin.sock`);
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

  onStateChange(cb: (s: SupervisorState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== cb);
    };
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
    for (const p of [this.coreSockPath, this.pluginSockPath]) {
      try {
        unlinkSync(p);
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
      listenAndChmod(this.coreServer, this.coreSockPath),
      listenAndChmod(this.pluginServer, this.pluginSockPath),
    ]);
  }

  private onCoreConnected(socket: Socket): void {
    // Plugin's uplink for the 17 core-side methods. No handler registered here —
    // that dispatch is 3.5's proxy. Still framed and violation-checked like any connection.
    const channel = new RpcChannel(socket);
    channel.onViolation((err) => this.onViolation(err));
  }

  private onPluginConnected(socket: Socket): void {
    this.pluginSocketRef = socket;
    const channel = new RpcChannel(socket);
    channel.onViolation((err) => this.onViolation(err));
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
    mkdirSync(join(this.opts.dir, 'data'), { recursive: true });
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

    this.child = spawn(plan.command, plan.args, plan.options);
    writePidFile(this.opts.runtimeDir, this.opts.id, this.child.pid!, plan.expectedCmdline);
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
          this.opts.logBuffer.error(line, undefined, tag);
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
      const res = await channel.call<{ manifest: unknown; token?: string }>(
        'hello',
        { pluginApi: PLUGIN_API_VERSION, coreVersion: CURRENT_FLIKS_VERSION, config: this.opts.config },
        this.opts.handshakeDeadlineMs,
      );
      // The token never travels core->plugin; only a process holding the real
      // FLIKS_PLUGIN_TOKEN (via its own env) can echo the right value back.
      if (res.token !== this.token) {
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
