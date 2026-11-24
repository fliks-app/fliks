import { afterNextRender, inject, Injector, signal } from '@angular/core';

/** A modal built on its first open: closed, it still cost every page open its whole content.
 *  The template renders it under `@if (built())`; `open` waits for that first render before showing it. */
export function lazyModal<T>(modal: () => T | undefined) {
  const injector = inject(Injector);
  const built = signal(false);
  return {
    built: built.asReadonly(),
    open(show: (m: T) => void): void {
      const m = modal();
      if (m) return show(m);
      built.set(true);
      afterNextRender(() => { const ready = modal(); if (ready) show(ready); }, { injector });
    },
  };
}
