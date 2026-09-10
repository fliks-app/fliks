import { Injectable } from '@angular/core';
import { Observable, fromEvent, map } from 'rxjs';

/**
 * The document scroll, behind one API so shared chrome (topbar, drawer,
 * scroll memory) reads and writes it the same way and the constraints below
 * live in a single place.
 */
@Injectable({ providedIn: 'root' })
export class PageScrollerService {
  private readonly changes$: Observable<void> = fromEvent(window, 'scroll', { passive: true }).pipe(
    map(() => undefined),
  );

  offset(): number {
    return window.scrollY;
  }

  /** Instant: TV builds set `scroll-behavior: smooth` for the D-pad, which
   *  would turn a restore into a competing animation. */
  scrollTo(top: number): void {
    window.scrollTo({ top, left: 0, behavior: 'instant' });
  }

  changes(): Observable<void> {
    return this.changes$;
  }
}
