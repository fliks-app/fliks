import { DestroyRef, inject, Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { AppResumeService } from './app-resume.service';
import { CachingReuseStrategy } from './route-reuse.strategy';
import { ScrollMemoryService } from './scroll-memory.service';

export interface KeepRouteFreshOptions {
  /**
   * Bring the page up to date. The cached DOM is what the user sees the instant
   * they return, so this runs behind it: no spinner, no flash, and the screen is
   * never left on whatever the data looked like when they navigated away. Also
   * fires when the native app comes back to the foreground on this page.
   */
  refresh?: () => void;
  /** Overrides {@link refresh} for the app-resume case, where the page is
   *  already on screen and a cache-first pass would repaint nothing. */
  refreshOnResume?: () => void;
  /** Scroll-memory key held while this route is on screen. Pass a function when
   *  the key depends on data that loads later (a library id, say); returning
   *  null skips the scroll handling for that pass. */
  scrollKey?: string | (() => string | null);
  onAttach?: () => void;
  onDetach?: () => void;
}

/**
 * Wire a `data: { reuse: true }` route to the cache that keeps it alive.
 *
 * Such a route is detached instead of destroyed, so `ngOnInit` does not run
 * again on return and `ngOnDestroy` does not run on the way out. Every cached
 * page therefore needs the same four things, which is what this does:
 *
 *  - revalidate on return, so the cache preloads the screen and a request still
 *    goes out to confirm it,
 *  - hold the scroll-memory key while attached, and release it on detach only
 *    if it is still ours (the next page claims its own in `ngOnInit`),
 *  - refresh on native app-resume, but only when this page is the visible one,
 *  - track whether the instance is parked in the cache.
 *
 * Call it from an injection context (a field initializer or the constructor).
 * Returns that detached state for anything else the page gates on it.
 */
export function keepRouteFresh(
  opts: KeepRouteFreshOptions,
): Signal<boolean> {
  const reuse = inject(CachingReuseStrategy);
  const route = inject(ActivatedRoute);
  const scrollMemory = inject(ScrollMemoryService);
  const appResume = inject(AppResumeService);
  const destroyRef = inject(DestroyRef);

  const detached = signal(false);
  // Read per event, never latched: a page that keeps its instance across a
  // param change (`reuseOnParamChange`) is filed under the params it last
  // showed, so a key captured on the first snapshot stops matching and the
  // page never learns it was detached.
  const ownKey = () => reuse.keyFor(route.snapshot);
  const scrollKey = (): string | null =>
    typeof opts.scrollKey === 'function'
      ? opts.scrollKey()
      : (opts.scrollKey ?? null);

  reuse.attached$.pipe(takeUntilDestroyed(destroyRef)).subscribe((key) => {
    if (key !== ownKey()) return;
    detached.set(false);
    const sk = scrollKey();
    if (sk) scrollMemory.activate(sk);
    opts.onAttach?.();
    opts.refresh?.();
    if (sk) scrollMemory.restoreSticky(sk);
  });

  reuse.detached$.pipe(takeUntilDestroyed(destroyRef)).subscribe((key) => {
    if (key !== ownKey()) return;
    detached.set(true);
    const sk = scrollKey();
    if (sk) scrollMemory.deactivateIf(sk);
    opts.onDetach?.();
  });

  appResume.resume$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => {
    if (detached()) return;
    (opts.refreshOnResume ?? opts.refresh)?.();
  });

  return detached.asReadonly();
}
