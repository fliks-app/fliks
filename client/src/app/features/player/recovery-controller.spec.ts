import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryController } from './recovery-controller';

function setup(overrides: Record<string, unknown> = {}) {
  const engine = {
    currentTime: 100,
    duration: 3600,
    resetRecoveryGuard: vi.fn(),
    unload: vi.fn(async () => {}),
    retry: undefined as undefined | (() => Promise<boolean>),
  };
  let online = true;
  const host: any = {
    engine: () => engine,
    isDestroyed: () => false,
    isCasting: () => false,
    isOnline: () => online,
    hasMedia: () => true,
    isPaused: () => false,
    isLoading: () => false,
    fatalNoRetry: () => false,
    reloadInFlight: () => false,
    lastSeekAt: () => 0,
    resumePosition: () => 100,
    setRecovering: vi.fn(),
    hasError: () => false,
    failWith: vi.fn(),
    reloadSession: vi.fn(async () => true),
    warmSession: vi.fn(async () => {}),
    beat: vi.fn(async () => {}),
    dropStall: vi.fn(() => null),
    closeStall: vi.fn(() => false),
    reportRecovery: vi.fn(),
    graceAfterReload: vi.fn(),
    ...overrides,
  };
  const ctl = new RecoveryController(host);
  return { ctl, host, engine, setOnline: (v: boolean) => (online = v) };
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('RecoveryController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a clock gap warms the session and beats, without a reload', async () => {
    const { ctl, host } = setup();
    ctl.armClock();
    vi.advanceTimersByTime(10 * 60_000);
    ctl.tickClockWatch();
    await flush();
    expect(host.warmSession).toHaveBeenCalledTimes(1);
    expect(host.beat).toHaveBeenCalledTimes(1);
    expect(host.reloadSession).not.toHaveBeenCalled();
  });

  it('the frozen interval does not read as a stalled playhead', async () => {
    const { ctl, host } = setup();
    ctl.resetStallWatchdog();
    ctl.armClock();
    vi.advanceTimersByTime(60_000);
    ctl.tickClockWatch();
    ctl.checkStall();
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
  });

  it('a playhead frozen past the timeout reloads the session at the resume position', async () => {
    const { ctl, host } = setup();
    ctl.resetStallWatchdog();
    vi.advanceTimersByTime(16_000);
    ctl.checkStall();
    await flush();
    expect(host.reloadSession).toHaveBeenCalledWith(100);
    expect(host.reportRecovery).toHaveBeenCalledWith(100, expect.objectContaining({ reason: 'stall' }));
  });

  it('a frozen playhead gets the longer window right after a seek', async () => {
    const { ctl, host } = setup({ lastSeekAt: () => Date.now() });
    ctl.resetStallWatchdog();
    vi.advanceTimersByTime(20_000);
    ctl.checkStall();
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
  });

  it('gives up after three failed attempts and unloads the engine behind the error card', async () => {
    const { ctl, host, engine } = setup({ reloadSession: vi.fn(async () => { throw new Error('gone'); }) });
    await ctl.recoverFromLostSession('stall');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(host.reloadSession).toHaveBeenCalledTimes(3);
    expect(engine.unload).toHaveBeenCalled();
    expect(host.failWith).toHaveBeenCalledTimes(1);
  });

  it('with the attempts already spent, shows the session error and unloads', async () => {
    const { ctl, host, engine } = setup({ reloadSession: vi.fn(async () => { throw new Error('gone'); }) });
    await ctl.recoverFromLostSession('stall');
    await vi.advanceTimersByTimeAsync(6_000);
    host.failWith.mockClear();
    await ctl.recoverFromLostSession('stall');
    expect(engine.unload).toHaveBeenCalled();
    expect(host.failWith).toHaveBeenCalledWith(undefined, { source: 'session' });
  });

  it('a stall while offline spends no attempt and recovers once back online', async () => {
    const { ctl, host, setOnline } = setup();
    setOnline(false);
    for (let i = 0; i < 5; i++) await ctl.recoverFromLostSession('stall');
    expect(host.reloadSession).not.toHaveBeenCalled();
    expect(host.failWith).not.toHaveBeenCalled();

    setOnline(true);
    ctl.armClock();
    ctl.tickClockWatch();
    await flush();
    expect(host.reloadSession).toHaveBeenCalledTimes(1);
  });

  it('back online, an engine that retries in place keeps the session; a second failure reloads', async () => {
    const { ctl, host, engine, setOnline } = setup();
    engine.retry = vi.fn(async () => true);
    setOnline(false);
    await ctl.recoverFromLostSession('session_expired');
    setOnline(true);
    ctl.armClock();
    ctl.tickClockWatch();
    await flush();
    expect(engine.retry).toHaveBeenCalledTimes(1);
    expect(host.reloadSession).not.toHaveBeenCalled();

    await ctl.recoverFromLostSession('session_expired', undefined, true);
    await flush();
    expect(engine.retry).toHaveBeenCalledTimes(1);
    expect(host.reloadSession).toHaveBeenCalledTimes(1);
  });

  it('playback sustained after a recovery clears the attempt count and re-arms the engine guard', async () => {
    const { ctl, engine } = setup();
    await ctl.recoverFromLostSession('stall');
    engine.currentTime = 101;
    vi.advanceTimersByTime(5_000);
    engine.currentTime = 106;
    ctl.checkStall();
    expect(engine.resetRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it('a recovery already running, or a user reload in flight, absorbs the trigger', async () => {
    const busy = setup({ reloadInFlight: () => true });
    await busy.ctl.recoverFromLostSession('session_lost');
    expect(busy.host.reloadSession).not.toHaveBeenCalled();
    expect(busy.host.setRecovering).toHaveBeenCalledWith(false);
  });

  it('a heartbeat lost to the network is retried once the player is online', async () => {
    const { ctl, host } = setup();
    ctl.markResumeDue();
    ctl.armClock();
    vi.advanceTimersByTime(6_000);
    ctl.tickClockWatch();
    await flush();
    expect(host.beat).toHaveBeenCalledTimes(1);
  });
});
