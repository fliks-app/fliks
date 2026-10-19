import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/** Signals the app returned to the foreground after a meaningful time in the background, so data pages can refresh silently.
 *  Native only (fed from Capacitor `pause`/`resume`); the threshold skips brief interruptions that can't have changed backend data. */
@Injectable({ providedIn: 'root' })
export class AppResumeService {
  /** Minimum time backgrounded before a resume counts as refresh-worthy. */
  private static readonly MIN_BACKGROUND_MS = 30_000;

  private readonly _resume$ = new Subject<void>();
  /** Emits once each time the app resumes after ≥ MIN_BACKGROUND_MS away. */
  readonly resume$: Observable<void> = this._resume$.asObservable();

  private backgroundedAt: number | null = null;

  /** Refresh data pages now, e.g. once a lost server is reachable again. */
  refresh(): void {
    this._resume$.next();
  }

  /** Call when the app goes to the background (Capacitor `pause`). */
  markBackgrounded(): void {
    this.backgroundedAt = Date.now();
  }

  /** Call on Capacitor `resume`: emits `resume$` only if backgrounded long enough; clears the marker so a repeat resume is a no-op. */
  markResumed(): void {
    const at = this.backgroundedAt;
    this.backgroundedAt = null;
    if (at !== null && Date.now() - at >= AppResumeService.MIN_BACKGROUND_MS) {
      this._resume$.next();
    }
  }
}
