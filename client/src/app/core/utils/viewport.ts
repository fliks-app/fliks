import { DestroyRef, Signal, inject, signal } from '@angular/core';

/** Tracks Tailwind's `md` (≥768px) so a template can render one layout instead of two hidden by CSS. */
export const MD_BREAKPOINT_QUERY = '(min-width: 768px)';

/** Live match of a media query; call from an injection context. Without matchMedia it reads true. */
export function mediaQuerySignal(query: string): Signal<boolean> {
  const matches = signal(true);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;
  const mq = window.matchMedia(query);
  matches.set(mq.matches);
  const onChange = (e: MediaQueryListEvent) => matches.set(e.matches);
  mq.addEventListener('change', onChange);
  inject(DestroyRef).onDestroy(() => mq.removeEventListener('change', onChange));
  return matches.asReadonly();
}
