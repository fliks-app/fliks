import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Remembers the last page before the player, kept across /watch to /watch hops, so leaving the player returns there. */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly router = inject(Router);
  private _originUrl: string | null = null;
  private _currentUrl: string | null = null;

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        // A skipLocationChange bounce through `/` only remounts the player; it is no page.
        if (this.router.getCurrentNavigation()?.extras.skipLocationChange) return;
        if (!this._currentUrl?.startsWith('/watch')) this._originUrl = this._currentUrl;
        this._currentUrl = e.urlAfterRedirects;
      });
  }

  /** Last non-player URL before the current one, or null on first nav. */
  get originUrl(): string | null {
    return this._originUrl;
  }
}
