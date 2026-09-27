import { vi } from 'vitest';
import { AbstractPlaybackEngine } from './playback-engine';

/** Exposes the protected guard; the abstract base implements all it needs. */
class TestEngine extends AbstractPlaybackEngine {
  triggerFrame(): void {
    this.emitFirstFrameOnce();
  }
  callMaybeEmitSessionExpired(err?: { source?: any; code?: number }): boolean {
    return this.maybeEmitSessionExpired(err);
  }
}

describe('AbstractPlaybackEngine.maybeEmitSessionExpired', () => {
  it('never recovers before a frame has played', () => {
    const engine = new TestEngine();
    expect(engine.callMaybeEmitSessionExpired()).toBe(false);
  });

  it('consumes the one-shot guard on the first post-frame error and emits sessionExpired', () => {
    const engine = new TestEngine();
    engine.triggerFrame();
    const handler = vi.fn();
    engine.on('sessionExpired', handler);

    expect(engine.callMaybeEmitSessionExpired()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    // Guard spent: a second error goes straight to a fatal error.
    expect(engine.callMaybeEmitSessionExpired()).toBe(false);
  });

  it('re-arms after resetRecoveryGuard', () => {
    const engine = new TestEngine();
    engine.triggerFrame();
    expect(engine.callMaybeEmitSessionExpired()).toBe(true);
    engine.resetRecoveryGuard();
    expect(engine.callMaybeEmitSessionExpired()).toBe(true);
  });

  it('an unambiguous decode/format code (native) skips the guess entirely, without spending the guard', () => {
    const engine = new TestEngine();
    engine.triggerFrame();
    const handler = vi.fn();
    engine.on('sessionExpired', handler);

    // ExoPlayer ERROR_CODE_DECODING_FAILED, never a session-expiry symptom.
    expect(engine.callMaybeEmitSessionExpired({ source: 'native', code: 4003 })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // The guard is still fresh: an actually-ambiguous error right after still recovers.
    expect(engine.callMaybeEmitSessionExpired()).toBe(true);
  });

  it('an ambiguous/unclassified error still uses the optimistic guess', () => {
    const engine = new TestEngine();
    engine.triggerFrame();
    expect(engine.callMaybeEmitSessionExpired({ source: 'native', code: 2004 })).toBe(true); // IO_BAD_HTTP_STATUS
  });
});
