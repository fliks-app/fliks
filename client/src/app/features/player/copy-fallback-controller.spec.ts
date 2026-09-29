import { describe, it, expect, vi } from 'vitest';
import { CopyFallbackController, type CopyFallbackHost } from './copy-fallback-controller';

const UNDECODABLE = { source: 'shaka' as const, code: 4032 };
const RECOVERABLE = { source: 'shaka' as const, code: 1002 };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHost(overrides: Partial<CopyFallbackHost> = {}): CopyFallbackHost {
  return {
    isDestroyed: () => false,
    playbackMode: () => 'remux',
    currentSid: () => 'sid-1',
    currentMediaFileId: () => 1,
    hasServerFeature: () => true,
    isReloadIdle: () => true,
    reloadStream: vi.fn(async () => {}),
    hasError: () => false,
    failWith: vi.fn(),
    setRecovering: vi.fn(),
    ...overrides,
  };
}

function createController(host: CopyFallbackHost): CopyFallbackController {
  const controller = new CopyFallbackController();
  controller.attach(host);
  return controller;
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('CopyFallbackController: gating', () => {
  it('ignores a destroyed host', () => {
    const host = createHost({ isDestroyed: () => true });
    const controller = createController(host);
    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(false);
    expect(host.reloadStream).not.toHaveBeenCalled();
  });

  it('ignores a delivery that is not DirectPlay/remux', () => {
    const host = createHost({ playbackMode: () => 'transcode' });
    const controller = createController(host);
    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(false);
    expect(host.reloadStream).not.toHaveBeenCalled();
  });

  it('is skipped entirely when the server lacks deviceProfileExtensions', () => {
    const host = createHost({ hasServerFeature: () => false });
    const controller = createController(host);
    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(false);
    expect(host.reloadStream).not.toHaveBeenCalled();
  });

  it('lets a recoverable error through unclaimed', () => {
    const host = createHost();
    const controller = createController(host);
    expect(controller.maybeFallback(RECOVERABLE, 0)).toBe(false);
    expect(host.reloadStream).not.toHaveBeenCalled();
  });

  it('classifies a rejected load(): a recoverable Error stays unclaimed, a 4032 is claimed', () => {
    const host = createHost();
    const controller = createController(host);
    const network = Object.assign(new Error('net'), { category: 1, code: 1002 });
    expect(controller.fallBackFromLoadError(network, 0)).toBe(false);
    expect(controller.fallBackFromLoadError({ category: 4, code: 4032 }, 0)).toBe(true);
  });

  it('ignores a failure with no session id', () => {
    const host = createHost({ currentSid: () => undefined });
    const controller = createController(host);
    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(false);
    expect(host.reloadStream).not.toHaveBeenCalled();
  });
});

describe('CopyFallbackController: one-shot-per-sid reload', () => {
  it('reloads once, marks the file rejected, then runs onRecovered', async () => {
    const host = createHost();
    const controller = createController(host);
    const onRecovered = vi.fn();

    expect(controller.maybeFallback(UNDECODABLE, 42, onRecovered)).toBe(true);
    // rejectCopyFileIds is written synchronously, before the reload even starts.
    expect(controller.shouldForceRejectCopy(1)).toBe(true);

    await flush();
    expect(host.reloadStream).toHaveBeenCalledExactlyOnceWith(42);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(host.setRecovering).toHaveBeenLastCalledWith(false);
  });

  it('absorbs a second report of the same sid while the reload is in flight, keeping either onRecovered', async () => {
    const reload = deferred<void>();
    const host = createHost({ reloadStream: vi.fn(() => reload.promise) });
    const controller = createController(host);
    const onRecovered = vi.fn();

    // The engine's `error` event arrives first, with no onRecovered of its own.
    expect(controller.maybeFallback(UNDECODABLE, 12)).toBe(true);
    // Shaka's rejected load() reports the same failure a tick later, carrying
    // the post-load setup its own catch skipped.
    expect(controller.maybeFallback(UNDECODABLE, 12, onRecovered)).toBe(true);

    reload.resolve();
    await flush();

    expect(host.reloadStream).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('cards normally once the in-flight fallback has settled, even for the same sid', async () => {
    const host = createHost();
    const controller = createController(host);

    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(true);
    await flush();

    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(false);
    expect(host.reloadStream).toHaveBeenCalledTimes(1);
  });

  it('re-arms for a fresh sid', async () => {
    let sid = 'sid-1';
    const host = createHost({ currentSid: () => sid });
    const controller = createController(host);

    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(true);
    await flush();

    sid = 'sid-2';
    expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(true);
    await flush();

    expect(host.reloadStream).toHaveBeenCalledTimes(2);
  });
});

describe('CopyFallbackController: waitForReloadIdle', () => {
  it('cards instead of leaving a dead player when another reload never idles', async () => {
    const host = createHost({ isReloadIdle: () => false });
    const controller = createController(host);

    vi.useFakeTimers();
    try {
      expect(controller.maybeFallback(UNDECODABLE, 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(3_100);
    } finally {
      vi.useRealTimers();
    }

    expect(host.reloadStream).not.toHaveBeenCalled();
    expect(host.failWith).toHaveBeenCalledWith(expect.any(Error), { source: 'session' });
  });

  it('does not re-card over an error the caller already set', async () => {
    const host = createHost({ isReloadIdle: () => false, hasError: () => true });
    const controller = createController(host);

    vi.useFakeTimers();
    try {
      controller.maybeFallback(UNDECODABLE, 0);
      await vi.advanceTimersByTimeAsync(3_100);
    } finally {
      vi.useRealTimers();
    }

    expect(host.failWith).not.toHaveBeenCalled();
  });

  it('proceeds once the guard lifts before the deadline', async () => {
    let idle = false;
    const host = createHost({ isReloadIdle: () => idle });
    const controller = createController(host);

    vi.useFakeTimers();
    try {
      controller.maybeFallback(UNDECODABLE, 7);
      await vi.advanceTimersByTimeAsync(500);
      idle = true;
      await vi.advanceTimersByTimeAsync(200);
    } finally {
      vi.useRealTimers();
    }

    expect(host.reloadStream).toHaveBeenCalledExactlyOnceWith(7);
  });
});

describe('CopyFallbackController: shouldForceRejectCopy', () => {
  it('is per file: another file still negotiates its copy', () => {
    const host = createHost();
    const controller = createController(host);
    controller.maybeFallback(UNDECODABLE, 0);
    expect(controller.shouldForceRejectCopy(1)).toBe(true);
    expect(controller.shouldForceRejectCopy(2)).toBe(false);
  });

  it('is gated on deviceProfileExtensions: never sent to a server that would 400 on it', () => {
    let hasFeature = true;
    const host = createHost({ hasServerFeature: () => hasFeature });
    const controller = createController(host);
    controller.maybeFallback(UNDECODABLE, 0);
    hasFeature = false;
    expect(controller.shouldForceRejectCopy(1)).toBe(false);
  });
});
