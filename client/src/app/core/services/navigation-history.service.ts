import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Tracks the URL the user was on right before the current navigation.
 *
 * Used by the player's onBack to decide between popping /watch via
 * history.back() (when the previous entry is already the target — avoids
 * a duplicate history entry from replaceUrl) and an explicit
 * router.navigate(target, replaceUrl).
 */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly router = inject(Router);
  private _previousUrl: string | null = null;
  private _currentUrl: string | null = null;

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this._previousUrl = this._currentUrl;
        this._currentUrl = e.urlAfterRedirects;
      });
  }

  /** URL that was active before the current navigation, or null on first nav. */
  get previousUrl(): string | null {
    return this._previousUrl;
  }
}
