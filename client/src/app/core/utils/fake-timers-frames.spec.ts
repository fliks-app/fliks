import { describe, expect, it, vi } from 'vitest';

// The order matters: the first test is the one that used to kill requestAnimationFrame for the rest of the worker.
describe('requestAnimationFrame after fake timers', () => {
  it('survives a focus made under fake timers', () => {
    vi.useFakeTimers();
    try {
      const button = document.body.appendChild(document.createElement('button'));
      button.focus();
      button.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still fires a frame', async () => {
    const t = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    expect(t).toBeGreaterThanOrEqual(0);
  });
});
