import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { mediaQuerySignal } from './viewport';

describe('mediaQuerySignal', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  function fakeMatchMedia(matches: boolean) {
    let listener: ((e: MediaQueryListEvent) => void) | null = null;
    const remove = vi.fn();
    window.matchMedia = vi.fn(() => ({
      matches,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => (listener = fn),
      removeEventListener: remove,
    })) as unknown as typeof window.matchMedia;
    return { fire: (m: boolean) => listener?.({ matches: m } as MediaQueryListEvent), remove };
  }

  it('reads the query and follows its changes', () => {
    const mq = fakeMatchMedia(false);
    const sig = runInInjectionContext(TestBed.inject(Injector), () => mediaQuerySignal('(min-width: 768px)'));
    expect(sig()).toBe(false);
    mq.fire(true);
    expect(sig()).toBe(true);
  });

  it('stops listening when its owner is destroyed', () => {
    const mq = fakeMatchMedia(true);
    runInInjectionContext(TestBed.inject(Injector), () => mediaQuerySignal('(min-width: 768px)'));
    TestBed.resetTestingModule();
    expect(mq.remove).toHaveBeenCalled();
  });

  it('reads true where matchMedia is missing', () => {
    // @ts-expect-error simulate an environment without matchMedia
    window.matchMedia = undefined;
    const sig = runInInjectionContext(TestBed.inject(Injector), () => mediaQuerySignal('(min-width: 768px)'));
    expect(sig()).toBe(true);
  });
});
