import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdTabNonce } from './tab-nonce';

describe('holdTabNonce', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('without Web Locks', () => {
    // Insecure contexts have no `navigator.locks`; BroadcastChannel stays available.
    const noLocks = () => vi.stubGlobal('navigator', { userAgent: '' });

    it('lets a tab keep a nonce nobody else holds', async () => {
      noLocks();
      expect(await holdTabNonce('aaaa0001')).toBe(true);
    });

    it('refuses a nonce a live tab already holds, and keeps it for the first tab', async () => {
      noLocks();
      expect(await holdTabNonce('aaaa0002')).toBe(true);
      expect(await holdTabNonce('aaaa0002')).toBe(false);
      expect(await holdTabNonce('aaaa0003')).toBe(true);
    });
  });

  describe('with Web Locks', () => {
    it('queues for a lock a reloading page has not released yet', async () => {
      let release: (() => void) | undefined;
      vi.stubGlobal('navigator', {
        locks: {
          request: (_: string, __: unknown, cb: () => unknown) =>
            new Promise<void>((resolve) => (release = () => resolve(void cb()))),
        },
      });
      const held = holdTabNonce('bbbb0001');
      release?.();
      expect(await held).toBe(true);
    });

    it('gives up on a lock a live tab keeps', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('navigator', {
          locks: {
            request: (_: string, o: { signal: AbortSignal }) =>
              new Promise((_res, reject) =>
                o.signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
              ),
          },
        });
        const held = holdTabNonce('bbbb0002');
        await vi.advanceTimersByTimeAsync(1000);
        expect(await held).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
