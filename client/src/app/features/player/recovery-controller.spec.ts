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
  let carded = false;
  const host: any = {
    engine: () => engine,
    isDestroyed: () => false,
    isCasting: () => false,
    isOnline: () => online,
    hasMedia: () => true,
    isPaused: () => false,
    isLoading: () => false,
    reloadInFlight: () => false,
    lastSeekAt: () => 0,
    resumePosition: () => 100,
    setRecovering: vi.fn(),
    hasError: () => carded,
    showFailure: vi.fn(() => (carded = true)),
    tryFallback: vi.fn(() => false),
    abandonReload: vi.fn(),
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
    expect(host.showFailure).toHaveBeenCalledExactlyOnceWith({ thrown: new Error('gone') });
  });

  it('with the card up, nothing retries any more', async () => {
    const { ctl, host } = setup({ reloadSession: vi.fn(async () => { throw new Error('gone'); }) });
    await ctl.recoverFromLostSession('stall');
    await vi.advanceTimersByTimeAsync(6_000);
    host.reloadSession.mockClear();
    await ctl.recoverFromLostSession('session_lost');
    ctl.onEngineError({ code: 2, message: 'network', source: 'media' });
    ctl.resetStallWatchdog();
    vi.advanceTimersByTime(60_000);
    ctl.checkStall();
    ctl.markResumeDue();
    ctl.tickClockWatch();
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
    expect(host.beat).not.toHaveBeenCalled();
    expect(host.showFailure).toHaveBeenCalledTimes(1);
  });

  it('a network error from the engine retries before any card', async () => {
    const { ctl, host } = setup();
    ctl.onEngineError({ code: 2, message: 'network', source: 'media' });
    await flush();
    expect(host.reloadSession).toHaveBeenCalledWith(100);
    expect(host.showFailure).not.toHaveBeenCalled();
  });

  it('an undecodable copy goes to the fallback, and to the card only when none is left', async () => {
    const decode = { code: 3, message: 'decode', source: 'media' as const };
    const withFallback = setup({ tryFallback: vi.fn(() => true) });
    withFallback.ctl.onEngineError(decode);
    await flush();
    expect(withFallback.host.showFailure).not.toHaveBeenCalled();
    expect(withFallback.host.reloadSession).not.toHaveBeenCalled();

    const { ctl, host } = setup();
    ctl.onEngineError(decode);
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
    expect(host.showFailure).toHaveBeenCalledExactlyOnceWith({ engine: decode });
  });

  it('an engine error during a reload is left to that reload; the card shows it once retries run out', async () => {
    let fail!: (e: Error) => void;
    const { ctl, host } = setup({
      reloadSession: vi.fn(() => new Promise<void>((_, reject) => (fail = reject))),
    });
    void ctl.recoverFromLostSession('stall');
    await flush();
    const e = { code: 2, message: 'network', source: 'media' as const };
    ctl.onEngineError(e);
    expect(host.reloadSession).toHaveBeenCalledTimes(1);
    fail(new Error('load failed'));
    await flush();
    expect(host.showFailure).not.toHaveBeenCalled();
  });

  it('ignores an error the engine reports as recoverable', async () => {
    const { ctl, host } = setup();
    ctl.onEngineError({ code: 1001, message: 'blip', source: 'shaka', category: 1, severity: 1 });
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
    expect(host.showFailure).not.toHaveBeenCalled();
  });

  it('a reload that never plays ends on the error card at the deadline; its late settle is dropped', async () => {
    let settle!: () => void;
    const { ctl, host, engine } = setup({
      reloadSession: vi.fn(() => new Promise<void>((r) => (settle = r))),
    });
    void ctl.recoverFromLostSession('stall');
    await flush();
    vi.advanceTimersByTime(44_000);
    ctl.checkStall();
    expect(host.showFailure).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    ctl.checkStall();
    expect(engine.unload).toHaveBeenCalled();
    expect(host.abandonReload).toHaveBeenCalled();
    expect(host.showFailure).toHaveBeenCalledWith({ source: 'session', code: 0 });
    expect(ctl.active).toBe(false);

    settle();
    await flush();
    expect(host.reportRecovery).not.toHaveBeenCalled();
  });

  it('a recovery parked offline past the deadline ends on the error card', async () => {
    const { ctl, host, setOnline } = setup();
    setOnline(false);
    await ctl.recoverFromLostSession('stall');
    vi.advanceTimersByTime(45_000);
    ctl.checkStall();
    expect(host.showFailure).toHaveBeenCalledWith({ source: 'session', code: 0 });

    setOnline(true);
    ctl.tickClockWatch();
    await flush();
    expect(host.reloadSession).not.toHaveBeenCalled();
  });

  it('a stall while offline spends no attempt and recovers once back online', async () => {
    const { ctl, host, setOnline } = setup();
    setOnline(false);
    for (let i = 0; i < 5; i++) await ctl.recoverFromLostSession('stall');
    expect(host.reloadSession).not.toHaveBeenCalled();
    expect(host.showFailure).not.toHaveBeenCalled();

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
