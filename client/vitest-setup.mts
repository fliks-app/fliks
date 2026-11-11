import { vi } from 'vitest';

// isolate:false keeps evaluated modules between files, so a spec's vi.mock would leak into the next ones.
vi.resetModules();

// jsdom 31 shares one interval between rAF and focus fixup; created under fake timers it stays dead for the worker.
const frameKeepAlive = globalThis as { __frameKeepAlive?: boolean };
if (!frameKeepAlive.__frameKeepAlive) {
  frameKeepAlive.__frameKeepAlive = true;
  const raf = window.requestAnimationFrame.bind(window);
  const loop = (): number => raf(loop);
  loop();
}
