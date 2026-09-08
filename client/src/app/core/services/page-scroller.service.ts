import { Injectable, inject, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject, Observable, fromEvent, map, switchMap } from 'rxjs';

/**
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

  /** Toggles `html.page-owns-scroll`, the CSS hook a claiming page's ancestor
   *  chain bounds itself against — see styles.css. */
  private readonly hostClassEffect = effect(() => {
    document.documentElement.classList.toggle('page-owns-scroll', this.element() !== null);
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

  scrollTo(top: number): void {
    const el = this.element();
    if (el) el.scrollTop = top;
    else window.scrollTo({ top, left: 0 });
  }

  changes(): Observable<void> {
    return this.changes$;
  }
}
