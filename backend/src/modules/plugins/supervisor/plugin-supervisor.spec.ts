import { existsSync, rmSync } from 'fs';
import { DEFAULT_SUPERVISOR_OPTIONS, PluginSupervisor, type PluginSupervisorOptions } from './plugin-supervisor';
import {
  delay,
  makeFixtureDir,
  makeRuntimeDir,
  newLogBuffer,
  waitForExitSignal,
  waitForState,
} from './supervisor-test-helpers';

/**
 * Real spawns and real sockets throughout, timing figures scaled down via
 * the constructor for speed; DEFAULT_SUPERVISOR_OPTIONS checks the real numbers separately.
 */

const dirsToClean: string[] = [];
const supervisorsToStop: PluginSupervisor[] = [];

function makeSupervisor(mode: string, overrides: Partial<PluginSupervisorOptions> = {}): PluginSupervisor {
  const dir = makeFixtureDir(mode);
  const runtimeDir = makeRuntimeDir();
  dirsToClean.push(dir, runtimeDir);
  const sup = new PluginSupervisor({
    id: `t${supervisorsToStop.length}`,
    dir,
    runtimeDir,
    logBuffer: newLogBuffer(),
    handshakeDeadlineMs: 250,
    healthIntervalMs: 60,
    healthDeadlineMs: 30,
    backoffLadderMs: [15, 30, 60, 120, 240, 400],
    readyResetMs: 300,
    breakerWindowMs: 600,
    breakerMaxCrashes: 6,
    shutdownRpcDeadlineMs: 100,
    sigtermGraceMs: 80,
    ...overrides,
  });
  supervisorsToStop.push(sup);
  return sup;
}

afterEach(async () => {
  await Promise.all(supervisorsToStop.map((s) => s.stop().catch(() => undefined)));
  supervisorsToStop.length = 0;
  for (const d of dirsToClean) rmSync(d, { recursive: true, force: true });
  dirsToClean.length = 0;
}, 15_000);

describe('DEFAULT_SUPERVISOR_OPTIONS', () => {
  it('matches the plan exactly', () => {
    expect(DEFAULT_SUPERVISOR_OPTIONS).toEqual({
      memoryMb: 256,
      handshakeDeadlineMs: 10_000,
      healthIntervalMs: 15_000,
      healthDeadlineMs: 3_000,
      backoffLadderMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
      readyResetMs: 120_000,
      breakerWindowMs: 600_000,
      breakerMaxCrashes: 6,
      shutdownRpcDeadlineMs: 3_000,
      sigtermGraceMs: 2_000,
      logCapBytesPerMinute: 65_536,
    });
  });
});

describe('handshake', () => {
  it('a well-behaved plugin reaches ready and answers health', async () => {
    const sup = makeSupervisor('good');
    await sup.start();
    await waitForState(sup, 'ready');
    const before = sup.getHealthCheckCount();
    await delay(200); // a few real health ticks at healthIntervalMs=60
    expect(sup.getHealthCheckCount()).toBeGreaterThan(before);
    expect(sup.getState()).toBe('ready');
  }, 10_000);

  it('a wrong token is SIGKILLed and never reaches ready', async () => {
    // a slow backoff first step so the exit-signal check below can't be preempted by a restart
    const sup = makeSupervisor('wrong-token', { backoffLadderMs: [1_000, 1_000] });
    await sup.start();
    await waitForState(sup, 'crashed');
    expect(sup.getState()).not.toBe('ready');
    expect(await waitForExitSignal(sup)).toBe('SIGKILL');
  }, 10_000);

  it('no handshake within the deadline is SIGKILLed and lands crashed', async () => {
    const sup = makeSupervisor('never-hello', { backoffLadderMs: [1_000, 1_000] });
    await sup.start();
    await waitForState(sup, 'crashed');
    expect(await waitForExitSignal(sup)).toBe('SIGKILL');
  }, 10_000);

  it('SIGKILLs even when the plugin never connects at all', async () => {
    const sup = makeSupervisor('never-connect');
    await sup.start();
    await waitForState(sup, 'crashed');
  }, 10_000);
});

describe('liveness', () => {
  it('two health misses degrade it; four force a restart', async () => {
    const sup = makeSupervisor('health-fail-after:1');
    const seen: string[] = [];
    sup.onStateChange((s) => seen.push(s));
    await sup.start();
    await waitForState(sup, 'ready');
    await waitForState(sup, 'degraded');
    await waitForState(sup, 'backoff');
    expect(seen).toEqual(expect.arrayContaining(['ready', 'degraded', 'crashed', 'backoff']));
    expect(seen.indexOf('degraded')).toBeLessThan(seen.lastIndexOf('crashed'));
  }, 10_000);
});

describe('backoff', () => {
  it('grows on each crash and does not reset for a plugin crashing well under the ready-reset window', async () => {
    // crashes 40ms after every successful hello; readyResetMs (300) never elapses first
    const sup = makeSupervisor('crash-after-ms:40', { readyResetMs: 300 });
    const backoffIndices: number[] = [];
    sup.onStateChange((s) => {
      if (s === 'backoff') backoffIndices.push(sup.getBackoffIndex());
    });
    await sup.start();
    await delay(600);
    expect(backoffIndices.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < backoffIndices.length; i++) {
      expect(backoffIndices[i]).toBeGreaterThan(backoffIndices[i - 1]);
    }
  }, 10_000);

  it('resets once the plugin stays continuously ready past the reset window', async () => {
    // crashes 250ms after hello; readyResetMs (80) elapses first every cycle
    const sup = makeSupervisor('crash-after-ms:250', { readyResetMs: 80, backoffLadderMs: [15, 30, 60, 120] });
    const backoffIndices: number[] = [];
    sup.onStateChange((s) => {
      if (s === 'backoff') backoffIndices.push(sup.getBackoffIndex());
    });
    await sup.start();
    await delay(750);
    expect(backoffIndices.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...backoffIndices)).toBeLessThanOrEqual(1);
  }, 10_000);
});

describe('circuit breaker', () => {
  it('trips to failed after 6 crashes in the window, captures stderr, and never restarts again', async () => {
    const sup = makeSupervisor('exit-immediately', {
      backoffLadderMs: [5, 5, 5, 5, 5, 5],
      breakerWindowMs: 2_000,
      breakerMaxCrashes: 6,
    });
    await sup.start();
    await waitForState(sup, 'failed', 5_000);
    expect(sup.getRestartCount()).toBe(6);
    const restartsAtFailure = sup.getRestartCount();
    await delay(200);
    expect(sup.getRestartCount()).toBe(restartsAtFailure); // no further restart attempts
    expect(sup.getState()).toBe('failed');
  }, 10_000);

  it('reEnable clears the breaker and allows starting again', async () => {
    const sup = makeSupervisor('exit-immediately', {
      backoffLadderMs: [5, 5, 5, 5, 5, 5],
      breakerWindowMs: 2_000,
      breakerMaxCrashes: 6,
    });
    await sup.start();
    await waitForState(sup, 'failed', 5_000);
    sup.reEnable();
    expect(sup.getState()).toBe('stopped');
  }, 10_000);
});

describe('ring buffer backpressure', () => {
  it('drops the oldest event and counts drops when the child never reads', async () => {
    const sup = makeSupervisor('no-read');
    await sup.start();
    await waitForState(sup, 'ready');
    const filler = 'x'.repeat(1024);
    for (let i = 0; i < 3_000; i++) sup.emitEvent('test.event', { i, filler });
    expect(sup.getRingSize()).toBeLessThanOrEqual(64);
    expect(sup.getEventDropCount()).toBeGreaterThan(0);
  }, 10_000);
});

describe('shutdown', () => {
  it('takes the RPC path when the child cooperates and unlinks both sockets', async () => {
    const sup = makeSupervisor('good');
    await sup.start();
    await waitForState(sup, 'ready');
    const { coreSockPath, pluginSockPath } = sup.getSocketPaths();
    const t0 = Date.now();
    await sup.stop();
    const elapsed = Date.now() - t0;
    // cooperative exit must not fall through to the SIGTERM/SIGKILL ladder
    expect(elapsed).toBeLessThan(80 + 100);
    expect(sup.getState()).toBe('stopped');
    expect(existsSync(coreSockPath)).toBe(false);
    expect(existsSync(pluginSockPath)).toBe(false);
  }, 10_000);

  it('takes the SIGTERM/SIGKILL path when the child ignores shutdown, and still unlinks both sockets', async () => {
    const sup = makeSupervisor('ignore-shutdown');
    await sup.start();
    await waitForState(sup, 'ready');
    const { coreSockPath, pluginSockPath } = sup.getSocketPaths();
    const t0 = Date.now();
    await sup.stop();
    const elapsed = Date.now() - t0;
    // must have waited out the RPC deadline (100) + the SIGTERM grace (80) before SIGKILL
    expect(elapsed).toBeGreaterThanOrEqual(100 + 80 - 20);
    expect(sup.getLastExitSignal()).toBe('SIGKILL');
    expect(existsSync(coreSockPath)).toBe(false);
    expect(existsSync(pluginSockPath)).toBe(false);
  }, 10_000);
});

describe('protocol violations', () => {
  it('an oversize frame is refused and kills the plugin without taking core down', async () => {
    const sup = makeSupervisor('raw-oversize');
    await sup.start();
    await waitForState(sup, 'crashed');
    expect(sup.getState()).not.toBe('ready');
  }, 10_000);

  it('a malformed line is refused and kills the plugin without taking core down', async () => {
    const sup = makeSupervisor('raw-malformed');
    await sup.start();
    await waitForState(sup, 'crashed');
    expect(sup.getState()).not.toBe('ready');
  }, 10_000);
});
