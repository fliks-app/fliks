import { describe, expect, it, vi } from 'vitest';

describe('tv-polyfills structuredClone', () => {
  it('clones plain data when the engine has no structuredClone', async () => {
    vi.stubGlobal('structuredClone', undefined);
    vi.resetModules();
    await import('./tv-polyfills');
    const src = { a: [1, { b: 2 }] };
    const copy = structuredClone(src);
    expect(copy).toEqual(src);
    expect(copy.a).not.toBe(src.a);
    vi.unstubAllGlobals();
  });
});
