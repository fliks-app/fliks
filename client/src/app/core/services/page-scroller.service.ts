import { Injectable, inject, signal } from '@angular/core';
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

  readonly element = signal<HTMLElement | null>(null);
  // Mirrors `element` synchronously: `changes()` has to re-target the instant
  // a claim changes, and a signal only replays through an effect flush.
  private readonly elementChanges = new BehaviorSubject<HTMLElement | null>(null);

  private readonly changes$: Observable<void> = this.elementChanges.pipe(
    switchMap((el) => fromEvent(el ?? window, 'scroll').pipe(map(() => undefined))),
  );

  constructor() {
    // A page that forgot to release() on its way out would otherwise poison
    // whichever page comes next; an element still attached to the live
    // document is somebody's live claim and is left alone.
    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const el = this.element();
      if (el && !document.contains(el)) this.setElement(null);
    });
  }

  claim(el: HTMLElement): void {
    this.setElement(el);
  }

  /** Same-owner guard as {@link ScrollMemoryService.deactivateIf}: a page
   *  navigated away from cannot wipe the claim of the page navigated to. */
  release(el: HTMLElement): void {
    if (this.element() === el) this.setElement(null);
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

  private setElement(el: HTMLElement | null): void {
    this.element.set(el);
    this.elementChanges.next(el);
  }
}
