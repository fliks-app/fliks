import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Remembers the last page before the player, kept across /watch to /watch hops, so leaving the player returns there. */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly router = inject(Router);
  /** Kept per tab so a reload of the player still knows where it came from. */
  private _originUrl: string | null = readOrigin();
  private _currentUrl: string | null = null;

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        // A skipLocationChange bounce through `/` only remounts the player; it is no page.
        if (this.router.getCurrentNavigation()?.extras.skipLocationChange) return;
        // The first page after a load keeps the stored origin only when it is the player itself.
        if (this._currentUrl === null) {
          if (!e.urlAfterRedirects.startsWith('/watch')) this._originUrl = null;
        } else if (!this._currentUrl.startsWith('/watch')) {
          this._originUrl = this._currentUrl;
        }
        this._currentUrl = e.urlAfterRedirects;
        writeOrigin(this._originUrl);
      });
  }

  /** Last non-player URL before the current one, or null on first nav. */
  get originUrl(): string | null {
    return this._originUrl;
  }
}

const ORIGIN_KEY = 'fliks.navOrigin';

function readOrigin(): string | null {
  try {
    return sessionStorage.getItem(ORIGIN_KEY);
  } catch {
    return null;
  }
}

function writeOrigin(url: string | null): void {
  try {
    if (url) sessionStorage.setItem(ORIGIN_KEY, url);
    else sessionStorage.removeItem(ORIGIN_KEY);
  } catch {
    // Storage blocked: the origin lives in memory only.
  }
}
