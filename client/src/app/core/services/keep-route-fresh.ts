import { DestroyRef, inject, Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { AppResumeService } from './app-resume.service';
import { CachingReuseStrategy } from './route-reuse.strategy';
import { NavbarService } from './navbar.service';
import { ScrollMemoryService } from './scroll-memory.service';

export interface KeepRouteFreshOptions {
  /** Bring the page up to date behind the cached DOM (no spinner or flash); also fires when the native app returns to the foreground. */
  refresh?: () => void;
  /** Overrides {@link refresh} for the app-resume case, where the page is
   *  already on screen and a cache-first pass would repaint nothing. */
  refreshOnResume?: () => void;
  /** Scroll-memory key held while on screen; a function when it depends on late data, null skips scroll handling. */
  scrollKey?: string | (() => string | null);
  onAttach?: () => void;
  onDetach?: () => void;
}

/** Wire a `data: { reuse: true }` route to its cache. Detached routes skip `ngOnInit`/`ngOnDestroy`, so this revalidates on return,
 *  holds the scroll key while attached, refreshes on app-resume when visible, and returns whether the page is parked. Needs an injection context. */
export function keepRouteFresh(
  opts: KeepRouteFreshOptions,
): Signal<boolean> {
  const reuse = inject(CachingReuseStrategy);
  const route = inject(ActivatedRoute);
  const scrollMemory = inject(ScrollMemoryService);
  const navbar = inject(NavbarService);
  const appResume = inject(AppResumeService);
  const destroyRef = inject(DestroyRef);

  const detached = signal(false);
  // Read per event, never latched: with `reuseOnParamChange` the page is filed under the params it last showed, so a first-snapshot key stops matching.
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
    // Entering forward is a new screen and starts where the router put it; only
    // a return asks the offset back, and its sticky pass holds it for 600ms.
    if (sk && navbar.navigatedBack()) scrollMemory.restoreSticky(sk);
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
