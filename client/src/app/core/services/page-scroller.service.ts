import { Injectable, inject, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject, Observable, fromEvent, map, switchMap } from 'rxjs';

/**
 * Which element scrolls the ACTIVE page, for shared chrome that has to read one
 * offset; {@link pageScrollOwner} answers the different question of which
 * scroller contains a given element.
 * Which element scrolls the current page — the library grid claims its own
 * container, everything else stays on the document (`element() === null`).
 * A single indirection lets shared chrome (topbar, drawer) read one API
 * instead of branching on which scroll model the active route uses.
 */
@Injectable({ providedIn: 'root' })
export class PageScrollerService {
  private readonly router = inject(Router);

  /** Single source of truth; `element` is a synchronous read of it so no
   *  outside `.set()` can desync the two. */
  private readonly elementChanges = new BehaviorSubject<HTMLElement | null>(null);
  readonly element = toSignal(this.elementChanges, { requireSync: true });

  private readonly changes$: Observable<void> = this.elementChanges.pipe(
    switchMap((el) => fromEvent(el ?? window, 'scroll', { passive: true }).pipe(map(() => undefined))),
  );

  /** Publishes the claimed scroller's gutter width, so fixed chrome (the
   *  topbar, the alphabet column) can stop short of a scrollbar the document
   *  never had. The layout mode itself is route data, not this service. */
  private readonly gutterEffect = effect(() => {
    const el = this.element();
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty('--page-scrollbar');
      return;
    }
    // Deferred: the gutter only exists once the element is actually bounded.
    requestAnimationFrame(() => {
      if (this.element() !== el) return;
      root.style.setProperty('--page-scrollbar', `${el.offsetWidth - el.clientWidth}px`);
    });
  });

  constructor() {
    // A page that forgot to release() on its way out would otherwise poison
    // whichever page comes next; an element still attached to the live
    // document is somebody's live claim and is left alone.
    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const el = this.element();
      if (el && !document.contains(el)) this.elementChanges.next(null);
    });
  }

  claim(el: HTMLElement): void {
    this.elementChanges.next(el);
  }

  /** Same-owner guard: a page navigated away from cannot wipe the claim of
   *  the page navigated to. */
  release(el: HTMLElement): void {
    if (this.element() === el) this.elementChanges.next(null);
  }

  offset(): number {
    return this.element()?.scrollTop ?? window.scrollY;
  }


  changes(): Observable<void> {
    return this.changes$;
  }
}
