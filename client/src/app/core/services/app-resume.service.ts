import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Broadcasts a "the app came back to the foreground after a meaningful spell
 * in the background" signal so data pages can silently refresh themselves.
 *
 * Native only: the root {@link App} component feeds it from Capacitor's
 * `pause` / `resume` listeners (web/desktop never call it, so `resume$` simply
 * never emits there). The threshold filters out brief interruptions — Control
 * Centre, a permission sheet, a glance at the app switcher — where the backend
 * data can't realistically have changed and a refetch would be wasted work.
 */
@Injectable({ providedIn: 'root' })
export class AppResumeService {
  /** Minimum time backgrounded before a resume counts as refresh-worthy. */
  private static readonly MIN_BACKGROUND_MS = 30_000;

  private readonly _resume$ = new Subject<void>();
  /** Emits once each time the app resumes after ≥ MIN_BACKGROUND_MS away. */
  readonly resume$: Observable<void> = this._resume$.asObservable();

  private backgroundedAt: number | null = null;

  /** Call when the app goes to the background (Capacitor `pause`). */
  markBackgrounded(): void {
    this.backgroundedAt = Date.now();
  }

  /**
   * Call when the app returns to the foreground (Capacitor `resume`). Emits
   * `resume$` iff it had been backgrounded long enough to be worth a refetch.
   * Clears the marker so a second resume without an intervening pause is a
   * no-op.
   */
  markResumed(): void {
    const at = this.backgroundedAt;
    this.backgroundedAt = null;
    if (at !== null && Date.now() - at >= AppResumeService.MIN_BACKGROUND_MS) {
      this._resume$.next();
    }
  }
}
