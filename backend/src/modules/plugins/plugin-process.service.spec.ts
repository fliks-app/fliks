import { rmSync } from 'fs';
import { join } from 'path';
import { PluginProcessService, type PluginSupervisorFactory } from './plugin-process.service';
import { installedPluginDir } from './plugin-paths';
import { buildZip } from './archive/zip-builder';
import { svgLogo } from './archive/test-fixtures';
import { getPluginsRuntimeDir } from '../../common/constants/paths';
import { createHash } from 'crypto';
import { minimalProcessManifest } from './archive/test-manifests';
import type { PluginPackage } from './entities/plugin-package.entity';
import type { PluginSupervisor, PluginSupervisorOptions, SupervisorState } from './supervisor/plugin-supervisor';
import type { PluginHostBindingService } from './host/plugin-host-binding.service';
import type { UnsafeCoreRefFk } from './plugin-database.service';

/**
 * Waits until the factory has built `count` supervisors, so a fake's state can be flipped
 * exactly where `startFor` is blocked. Bounded by wall clock, not by a tick budget:
 * `startFor` re-extracts a real archive, and microtask pumping does not wait for disk.
 */
async function waitForSupervisors(instances: FakeSupervisor[], count = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (instances.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (instances.length < count) throw new Error(`only ${instances.length} supervisor(s) built, wanted ${count}`);
}

class FakeSupervisor {
  state: SupervisorState = 'stopped';
  stderrTail = '';
  statusMessage = '';
  startCalls = 0;
  stopCalls = 0;
  emitEvent = jest.fn();
  private listeners: ((s: SupervisorState) => void)[] = [];

  constructor(public readonly options: PluginSupervisorOptions) {}

  getState(): SupervisorState {
    return this.state;
  }
  getStderrTail(): string {
    return this.stderrTail;
  }
  getStatusMessage(): string {
    return this.statusMessage;
  }

  onStateChange(cb: (s: SupervisorState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  setState(s: SupervisorState): void {
    this.state = s;
    for (const cb of [...this.listeners]) cb(s);
  }

  async start(): Promise<void> {
    this.startCalls++;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.setState('stopped');
  }
}

function makeFactory(): { factory: PluginSupervisorFactory; instances: FakeSupervisor[] } {
  const instances: FakeSupervisor[] = [];
  const factory = (options: PluginSupervisorOptions): PluginSupervisor => {
    const sup = new FakeSupervisor(options);
    instances.push(sup);
    return sup as unknown as PluginSupervisor;
  };
  return { factory, instances };
}

function fakePluginDb(order: string[] = []) {
  return {
    provision: jest.fn(async () => {
      order.push('provision');
    }),
    findUnsafeCoreRefFks: jest.fn(async (): Promise<UnsafeCoreRefFk[]> => []),
    rotatePassword: jest.fn(async () => {
      order.push('rotate');
      return 'postgresql://fake-dsn' as string | null;
    }),
    deprovision: jest.fn(async () => undefined),
  };
}

function fakeLogBuffer() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function fakeSettings(order: string[] = [], all: Record<string, string | null> = {}) {
  return {
    getAll: jest.fn(async () => {
      order.push('config');
      return all;
    }),
  };
}

const PLUGIN_ID = 'fliks.processsvc';
const PLUGIN_JS = Buffer.from('module.exports = {};');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A real archive, because `startFor` re-extracts and re-hashes on every spawn — that is L3. */
function fakePackage(overrides: Partial<PluginPackage> = {}, manifestOverrides: Record<string, unknown> = {}): PluginPackage {
  const logo = svgLogo();
  const manifest = minimalProcessManifest(
    { 'plugin.js': sha(PLUGIN_JS), 'logo.svg': sha(logo) },
    { id: PLUGIN_ID, memoryMb: 256, logo: 'logo.svg', ...manifestOverrides },
  );
  const archive = buildZip([
    { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'plugin.js', content: PLUGIN_JS },
    { name: 'logo.svg', content: logo },
  ]);
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    archive,
    origin: 'manual',
    signature: 'unsigned',
    verifiedByKeyId: null,
    manifest,
    status: 'active',
    ...overrides,
  } as PluginPackage;
}

describe('PluginProcessService.startFor', () => {
  beforeEach(() => {
    rmSync(join(getPluginsRuntimeDir(), 'installed'), { recursive: true, force: true });
  });

  it('runs materialise -> provision -> rotate -> config -> spawn, in that order, and resolves once ready', async () => {
    const order: string[] = [];
    const pkg = fakePackage();

    const pluginDb = fakePluginDb(order);
    const settings = fakeSettings(order);
    const { factory: rawFactory, instances } = makeFactory();
    const factory: PluginSupervisorFactory = (options) => {
      order.push('spawn');
      return rawFactory(options);
    };
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, settings as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('handshaking');
    instances[0].setState('ready');
    const result = await startPromise;

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['provision', 'rotate', 'config', 'spawn']);
    expect(instances).toHaveLength(1);
    expect(instances[0].startCalls).toBe(1);
    expect(instances[0].options).toEqual(
      expect.objectContaining({ id: pkg.pluginId, dbUrl: 'postgresql://fake-dsn', memoryMb: 256 }),
    );
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });

  it("binds the supervisor's hostApi to this plugin's own id when a PluginHostBindingService is given", async () => {
    const pkg = fakePackage();
    const boundApi = { 'config.get': jest.fn() };
    const bind = jest.fn().mockReturnValue(boundApi);
    const hostBinding = { bind } as unknown as PluginHostBindingService;
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(
      fakePluginDb() as never,
      fakeLogBuffer() as never,
      fakeSettings() as never,
      factory,
      undefined,
      hostBinding,
    );

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    await startPromise;

    expect(bind).toHaveBeenCalledWith(pkg.pluginId);
    expect(instances[0].options.hostApi).toBe(boundApi);
  });

  it('passes a null rotated password through as undefined', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    pluginDb.rotatePassword.mockResolvedValue(null);
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    await startPromise;

    expect(instances[0].options.dbUrl).toBeUndefined();
  });

  it('only forwards plugin.<id>.* settings as config, dropping null values and other plugins', async () => {
    const pkg = fakePackage();

    const settings = fakeSettings([], {
      [`plugin.${PLUGIN_ID}.apiKey`]: 'secret',
      [`plugin.${PLUGIN_ID}.cleared`]: null,
      'plugin.someone-else.apiKey': 'nope',
    });
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, settings as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    await startPromise;

    expect(instances[0].options.config).toEqual({ [`plugin.${PLUGIN_ID}.apiKey`]: 'secret' });
  });

  it('a corrupt archive fails materialise with "tampered", spawning nothing', async () => {
    const pkg = fakePackage({ archive: Buffer.from('not a zip at all') });
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const result = await service.startFor(pkg);

    expect(result).toEqual({ ok: false, reason: 'tampered', detail: expect.any(String) });
    expect(instances).toHaveLength(0);
    expect(service.stateOf(pkg.pluginId)).toBeNull();
  });

  it('a provision failure returns "db-provision-failed" and spawns nothing', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    pluginDb.provision.mockRejectedValue(new Error('db unreachable'));
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const result = await service.startFor(pkg);

    expect(result).toEqual({ ok: false, reason: 'db-provision-failed', detail: 'db unreachable' });
    expect(instances).toHaveLength(0);
  });

  it('an unsafe core-ref foreign key warns for every offending constraint but still starts the plugin', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    pluginDb.findUnsafeCoreRefFks.mockResolvedValue([
      { constraint: 'zz_probe_mediaId_fkey', table: 'zz_probe', referencedTable: 'media' },
      { constraint: 'zz_second_fkey', table: 'zz_second', referencedTable: 'episodes' },
    ]);
    const logBuffer = fakeLogBuffer();
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, logBuffer as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    const result = await startPromise;

    expect(result).toEqual({ ok: true });
    expect(instances).toHaveLength(1);
    expect(pluginDb.rotatePassword).toHaveBeenCalled();
    expect(logBuffer.warn).toHaveBeenCalledWith(expect.stringContaining('zz_probe_mediaId_fkey'), `plugin:${pkg.pluginId}`);
    expect(logBuffer.warn).toHaveBeenCalledWith(expect.stringContaining('zz_second_fkey'), `plugin:${pkg.pluginId}`);
    expect(service.statusMessageOf(pkg.pluginId)).toContain('zz_probe_mediaId_fkey');
    expect(service.statusMessageOf(pkg.pluginId)).toContain('zz_second_fkey');
  });

  it('a rotatePassword failure also returns "db-provision-failed" and spawns nothing', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    pluginDb.rotatePassword.mockRejectedValue(new Error('role missing'));
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const result = await service.startFor(pkg);

    expect(result).toEqual({ ok: false, reason: 'db-provision-failed', detail: 'role missing' });
    expect(instances).toHaveLength(0);
  });

  it('a breaker trip ("failed") returns "spawn-failed" with the stderr tail, but the supervisor is left running and observable', async () => {
    const pkg = fakePackage();

    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].stderrTail = 'boom: could not bind';
    instances[0].setState('crashed');
    instances[0].setState('failed');
    const result = await startPromise;

    expect(result).toEqual({ ok: false, reason: 'spawn-failed', detail: 'boom: could not bind' });
    expect(instances[0].stopCalls).toBe(0);
    expect(service.stateOf(pkg.pluginId)).toBe('failed');
  });

  it('a slow handshake reports failure once the timeout elapses, without stopping or dropping the supervisor', async () => {
    const pkg = fakePackage();

    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, fakeSettings() as never, factory, 20);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('handshaking');
    const result = await startPromise;

    expect(result).toEqual({ ok: false, reason: 'spawn-failed', detail: expect.any(String) });
    expect(instances[0].stopCalls).toBe(0);
    expect(service.stateOf(pkg.pluginId)).toBe('handshaking');
  });

  it('crashing and backing off on the way to ready still yields ok:true, and the supervisor is never stopped', async () => {
    const pkg = fakePackage();

    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('starting');
    instances[0].setState('handshaking');
    instances[0].setState('crashed');
    instances[0].setState('backoff');
    instances[0].setState('handshaking');
    instances[0].setState('ready');
    const result = await startPromise;

    expect(result).toEqual({ ok: true });
    expect(instances[0].stopCalls).toBe(0);
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });

  it('called again for an id that is already running stops the old supervisor before spawning a new one', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const firstStart = service.startFor(pkg);
    await waitForSupervisors(instances, 1);
    instances[0].setState('ready');
    await firstStart;

    const secondStart = service.startFor(pkg);
    await waitForSupervisors(instances, 2);
    instances[1].setState('ready');
    await secondStart;

    expect(instances[0].stopCalls).toBe(1);
    expect(instances).toHaveLength(2);
    expect(instances[1].startCalls).toBe(1);
    expect(pluginDb.rotatePassword).toHaveBeenCalledTimes(2);
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });
});

describe('PluginProcessService — lifecycle', () => {
  beforeEach(() => {
    rmSync(join(getPluginsRuntimeDir(), 'installed'), { recursive: true, force: true });
  });

  async function startedService() {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    await startPromise;

    return { service, pkg, pluginDb, instances, factory };
  }

  it('stopFor stops the supervisor and is idempotent', async () => {
    const { service, pkg, instances } = await startedService();

    await service.stopFor(pkg.pluginId);
    await service.stopFor(pkg.pluginId);

    expect(instances[0].stopCalls).toBe(1);
    expect(service.stateOf(pkg.pluginId)).toBeNull();
  });

  it('stateOf/statusMessageOf report unknown for a plugin never started', () => {
    const service = new PluginProcessService(fakePluginDb() as never, fakeLogBuffer() as never, fakeSettings() as never, makeFactory().factory);

    expect(service.stateOf('fliks.never-started')).toBeNull();
    expect(service.statusMessageOf('fliks.never-started')).toBe('');
  });

  it('statusMessageOf falls back to the stderr tail of a plugin that is down', async () => {
    const { service, pkg, instances } = await startedService();
    instances[0].stderrTail = 'last gasp';
    instances[0].setState('crashed');

    expect(service.statusMessageOf(pkg.pluginId)).toBe('last gasp');
  });

  it('statusMessageOf reports nothing for a healthy plugin that logged warnings', async () => {
    const { service, pkg, instances } = await startedService();
    instances[0].stderrTail = 'WARN no download client configured yet\n';

    expect(service.stateOf(pkg.pluginId)).toBe('ready');
    expect(service.statusMessageOf(pkg.pluginId)).toBe('');
  });

  it('startFor stops the old supervisor and spawns a fresh one, rotating the password again', async () => {
    const { service, pkg, pluginDb, instances } = await startedService();
    expect(pluginDb.rotatePassword).toHaveBeenCalledTimes(1);

    const restartPromise = service.startFor(pkg);
    await waitForSupervisors(instances, 2);
    instances[1].setState('ready');
    const result = await restartPromise;

    expect(result).toEqual({ ok: true });
    expect(instances).toHaveLength(2);
    expect(instances[0].stopCalls).toBe(1);
    expect(instances[1].startCalls).toBe(1);
    expect(pluginDb.rotatePassword).toHaveBeenCalledTimes(2);
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });

  it('startFor cold-starts a plugin that never reached running, rather than no-op-ing', async () => {
    const pkg = fakePackage();
    const pluginDb = fakePluginDb();
    pluginDb.provision.mockRejectedValueOnce(new Error('db unreachable'));
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const firstResult = await service.startFor(pkg);
    expect(firstResult).toEqual({ ok: false, reason: 'db-provision-failed', detail: 'db unreachable' });
    expect(service.stateOf(pkg.pluginId)).toBeNull();

    const restartPromise = service.startFor(pkg);
    await waitForSupervisors(instances, 1);
    instances[0].setState('ready');
    const result = await restartPromise;

    expect(result).toEqual({ ok: true });
    expect(instances).toHaveLength(1);
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });

  it('a plugin whose start failed is still present for stateOf/statusMessageOf, and startFor respawns it', async () => {
    const pkg = fakePackage();

    const pluginDb = fakePluginDb();
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);

    const startPromise = service.startFor(pkg);
    await waitForSupervisors(instances);
    instances[0].stderrTail = 'boom';
    instances[0].setState('crashed');
    instances[0].setState('failed');
    const startResult = await startPromise;

    expect(startResult).toEqual({ ok: false, reason: 'spawn-failed', detail: 'boom' });
    expect(service.stateOf(pkg.pluginId)).toBe('failed');
    expect(service.statusMessageOf(pkg.pluginId)).toBe('boom');

    const restartPromise = service.startFor(pkg);
    await waitForSupervisors(instances, 2);
    instances[1].setState('ready');
    await restartPromise;

    expect(instances[0].stopCalls).toBe(1);
    expect(service.stateOf(pkg.pluginId)).toBe('ready');
  });

  it('stopAll stops every running plugin', async () => {
    const pluginDb = fakePluginDb();
    const { factory, instances } = makeFactory();
    const service = new PluginProcessService(pluginDb as never, fakeLogBuffer() as never, fakeSettings() as never, factory);
    const pkgA = fakePackage({}, { id: 'fliks.processsvc.a' });
    const pkgB = fakePackage({}, { id: 'fliks.processsvc.b' });



    const p1 = service.startFor(pkgA);
    await waitForSupervisors(instances);
    instances[0].setState('ready');
    await p1;
    const p2 = service.startFor(pkgB);
    await waitForSupervisors(instances, 2);
    instances[1].setState('ready');
    await p2;

    await service.stopAll();

    expect(instances[0].stopCalls).toBe(1);
    expect(instances[1].stopCalls).toBe(1);
    expect(service.stateOf(pkgA.pluginId)).toBeNull();
    expect(service.stateOf(pkgB.pluginId)).toBeNull();
  });

  it('emitToAll reaches every running supervisor regardless of state — the ring buffer decides queue vs. send', async () => {
    const { service, instances } = await startedService();
    instances[0].setState('degraded');

    service.emitToAll('media.imported', { mediaId: 1 });

    expect(instances[0].emitEvent).toHaveBeenCalledWith('media.imported', { mediaId: 1 });
  });
});
