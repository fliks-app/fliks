import { Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import type { PluginPackage } from './entities/plugin-package.entity';
import { installedPluginDir, promoteDir } from './plugin-paths';
import { extractToStaging } from './archive';
import { PluginDatabaseService } from './plugin-database.service';
import {
  DEFAULT_SUPERVISOR_OPTIONS,
  PluginSupervisor,
  type PluginSupervisorOptions,
  type SupervisorState,
} from './supervisor/plugin-supervisor';
import { LogBufferService } from '../scheduler/log-buffer.service';
import { SettingsService } from '../settings/settings.service';
import type { ProcessPluginManifest } from '../../common/plugin-contract';
import { PluginHostBindingService } from './host/plugin-host-binding.service';

export type PluginProcessFailureReason = 'tampered' | 'db-provision-failed' | 'spawn-failed';
export type PluginProcessStartResult = { ok: true } | { ok: false; reason: PluginProcessFailureReason; detail: string };
export type PluginSupervisorFactory = (options: PluginSupervisorOptions) => PluginSupervisor;

interface RunningPlugin {
  supervisor: PluginSupervisor;
  pkg: PluginPackage;
  unsubscribe: () => void;
}

const DEFAULT_FACTORY: PluginSupervisorFactory = (options) => new PluginSupervisor(options);

/** States where the stderr tail is the diagnosis rather than routine output. */
const DOWN_STATES: ReadonlySet<SupervisorState> = new Set(['crashed', 'backoff', 'failed', 'degraded']);

/** Owns every live `process` plugin's supervisor, one per plugin id. `startFor`/`stopFor`
 *  are the map's only entry and exit, so it always reflects who is actually spawned. */
@Injectable()
export class PluginProcessService implements OnApplicationShutdown {
  private readonly running = new Map<string, RunningPlugin>();
  private readonly supervisorFactory: PluginSupervisorFactory;
  private readonly startupTimeoutMs: number;
  private readonly hostBinding: PluginHostBindingService | null;

  constructor(
    private readonly pluginDb: PluginDatabaseService,
    private readonly logBuffer: LogBufferService,
    private readonly settings: SettingsService,
    @Optional() supervisorFactory?: PluginSupervisorFactory,
    @Optional() startupTimeoutMs?: number,
    // Optional (rather than an import edge to PluginHostModule) so tests that
    // build this service by hand need not supply it — see plugin-host.module.ts.
    @Optional() hostBinding?: PluginHostBindingService,
  ) {
    this.supervisorFactory = supervisorFactory ?? DEFAULT_FACTORY;
    this.startupTimeoutMs = startupTimeoutMs ?? DEFAULT_SUPERVISOR_OPTIONS.handshakeDeadlineMs;
    this.hostBinding = hostBinding ?? null;
  }

  /** Materialise -> provision-check -> rotate -> config -> spawn; each stage's failure
   *  carries its own reason. A slow handshake is reported but left running to retry on its own. */
  async startFor(pkg: PluginPackage): Promise<PluginProcessStartResult> {
    const manifest = pkg.manifest;
    if (manifest.kind !== 'process') {
      throw new Error(`startFor() called for non-process plugin "${pkg.pluginId}"`);
    }

    const materialised = await this.materialise(pkg, manifest);
    if (!materialised.ok) return { ok: false, reason: 'tampered', detail: materialised.detail };

    try {
      await this.pluginDb.provision(manifest);
    } catch (err) {
      return { ok: false, reason: 'db-provision-failed', detail: (err as Error).message };
    }

    let dbUrl: string | undefined;
    try {
      dbUrl = (await this.pluginDb.rotatePassword(pkg.pluginId)) ?? undefined;
    } catch (err) {
      return { ok: false, reason: 'db-provision-failed', detail: (err as Error).message };
    }

    const config = await this.readConfig(pkg.pluginId);
    const supervisor = this.supervisorFactory({
      id: pkg.pluginId,
      dir: materialised.dir,
      logBuffer: this.logBuffer,
      dbUrl,
      config,
      memoryMb: manifest.memoryMb,
      hostApi: this.hostBinding?.bind(pkg.pluginId) ?? null,
    });
    const unsubscribe = supervisor.onStateChange((state) =>
      this.logBuffer.log(`state: ${state}`, `plugin:${pkg.pluginId}`),
    );
    // Registered before the handshake settles: a plugin stuck retrying its own backoff
    // ladder must stay observable and restartable, not vanish because it isn't ready yet.
    this.running.set(pkg.pluginId, { supervisor, pkg, unsubscribe });

    await supervisor.start();
    const outcome = await this.waitForReadyOrGiveUp(supervisor);
    if (!outcome.ok) return { ok: false, reason: 'spawn-failed', detail: outcome.detail };
    return { ok: true };
  }

  /** Idempotent — a no-op for a plugin that was never started, or already stopped. */
  async stopFor(pluginId: string): Promise<void> {
    const entry = this.running.get(pluginId);
    if (!entry) return;
    this.running.delete(pluginId);
    entry.unsubscribe();
    await entry.supervisor.stop();
  }

  stateOf(pluginId: string): SupervisorState | null {
    return this.running.get(pluginId)?.supervisor.getState() ?? null;
  }

  statusMessageOf(pluginId: string): string {
    const supervisor = this.running.get(pluginId)?.supervisor;
    if (!supervisor) return '';
    const breakerMessage = supervisor.getStatusMessage();
    if (breakerMessage) return breakerMessage;
    // The stderr tail explains a failure; a healthy plugin's own warnings are not its status.
    return DOWN_STATES.has(supervisor.getState()) ? supervisor.getStderrTail() : '';
  }

  /** Passthrough so the HTTP proxy never touches a supervisor directly. */
  callPlugin<T = unknown>(pluginId: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
    const supervisor = this.running.get(pluginId)?.supervisor;
    if (!supervisor) return Promise.reject(new Error(`plugin "${pluginId}" is not running`));
    return supervisor.callPlugin<T>(method, params, timeoutMs);
  }

  /** Swaps in a fresh supervisor rather than reusing the tripped one, so the rotated password stays "once per spawn". */
  async restart(pluginId: string): Promise<void> {
    const entry = this.running.get(pluginId);
    if (!entry) return;
    await this.stopFor(pluginId);
    await this.startFor(entry.pkg);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopFor(id)));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stopAll();
  }

  /** Unconditional — the supervisor's own ring buffer, not this method, decides queue vs. send. */
  emitToAll(name: string, payload: unknown): void {
    for (const { supervisor } of this.running.values()) {
      supervisor.emitEvent(name, payload);
    }
  }

  /**
   * Always rebuilt from `pkg.archive`, never trusted from disk: extraction re-hashes every
   * entry against the signed `files{}`, which is L3. Trusting an existing directory would
   * skip that check on exactly the persistent `FLIKS_RUNTIME_DIR` where tampering is possible.
   */
  private async materialise(
    pkg: PluginPackage,
    manifest: ProcessPluginManifest,
  ): Promise<{ ok: true; dir: string } | { ok: false; detail: string }> {
    const dir = installedPluginDir(pkg.pluginId, pkg.version);

    try {
      const extracted = await extractToStaging(pkg.archive, manifest);
      if (!extracted.ok) return { ok: false, detail: extracted.detail };
      promoteDir(extracted.dir, dir);
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** `plugin.<id>.*` app settings, verbatim keys — `buildSpawnPlan` re-keys them to `FLIKS_CFG_*`. */
  private async readConfig(pluginId: string): Promise<Record<string, string>> {
    const prefix = `plugin.${pluginId}.`;
    const all = await this.settings.getAll();
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
      if (value !== null && key.startsWith(prefix)) config[key] = value;
    }
    return config;
  }

  /** `crashed`/`backoff` are the ladder doing its job, not a verdict — only `ready` (success),
   *  `failed` (the breaker gave up) or this method's own timeout end the wait. */
  private waitForReadyOrGiveUp(supervisor: PluginSupervisor): Promise<{ ok: true } | { ok: false; detail: string }> {
    const failureDetail = () => supervisor.getStatusMessage() || supervisor.getStderrTail();

    return new Promise((resolve) => {
      const initial = supervisor.getState();
      if (initial === 'ready') {
        resolve({ ok: true });
        return;
      }
      if (initial === 'failed') {
        resolve({ ok: false, detail: failureDetail() });
        return;
      }

      const settle = (result: { ok: true } | { ok: false; detail: string }) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = supervisor.onStateChange((state) => {
        if (state === 'ready') settle({ ok: true });
        else if (state === 'failed') settle({ ok: false, detail: failureDetail() });
      });
      const timer = setTimeout(
        () => settle({ ok: false, detail: failureDetail() || 'handshake deadline exceeded' }),
        this.startupTimeoutMs,
      );
    });
  }
}
