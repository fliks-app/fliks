import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Tracks the URL before the current navigation, so the player's onBack can `history.back()` when the previous entry is already the target, avoiding a duplicate from replaceUrl. */
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
