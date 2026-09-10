import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Navigation, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { DisplaySettingsService } from './display-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { fanartPool } from '../../shared/utils/media-artwork.util';

/** How long an ambient image stays before a navigation may replace it. */
const AMBIENT_TTL = 5 * 60 * 1000;

/** Settings and admin pages take no backdrop at all. */
const BARE_ROUTES = ['/app-settings', '/account', '/admin'];

/**
 * Global page-background image. A media page declares its own fanart and wins
 * while it is on screen; every other page shows the ambient image, drawn from
 * the viewer's recommendations and held across navigations.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly streamingApi = inject(StreamingApiService);

  private readonly claim = signal<{ owner: object; url: string } | null>(null);
  private readonly ambient = signal<string | null>(null);
  private ambientAt = 0;
  private rolling = false;

  private readonly currentPath = computed(() => {
    const nav = this.router.lastSuccessfulNavigation();
    return nav ? this.pathOf(nav) : this.router.url;
  });

  readonly url = computed(() => {
    if (BARE_ROUTES.some((p) => this.currentPath().startsWith(p))) return null;
    if (!this.auth.isAuthenticated()) return null;
    return (
      this.claim()?.url ?? (this.displaySettings.settings().homeBackground ? this.ambient() : null)
    );
  });

  /** Declare the media page's fanart; `null` means not known yet, and holds. */
  set(owner: object, url: string | null): void {
    if (url) this.claim.set({ owner, url });
  }

  release(owner: object): void {
    if (this.claim()?.owner === owner) this.claim.set(null);
  }

  /** A page leaving the screen hands the backdrop back — unless the player is
   *  what covers it, which it has to come back from on the same image. */
  suspend(owner: object): void {
    const nav = this.router.currentNavigation();
    if (!isPlayer(nav ? this.pathOf(nav) : this.router.url)) this.release(owner);
  }

  /** Each navigation may replace the ambient image, except a trip through the
   *  player: however long the film ran, the viewer comes back to what they left. */
  private readonly navigationEffect = effect(() => {
    const nav = this.router.lastSuccessfulNavigation();
    if (!nav) return;
    const from = nav.previousNavigation;
    if (isPlayer(this.pathOf(nav)) || (from && isPlayer(this.pathOf(from)))) return;
    untracked(() => void this.rollAmbient());
  });

  private async rollAmbient(): Promise<void> {
    if (this.rolling || Date.now() - this.ambientAt < AMBIENT_TTL) return;
    if (!this.auth.isAuthenticated() || !this.displaySettings.settings().homeBackground) return;
    this.rolling = true;
    try {
      // Same request as the home page, so this is served from its cache.
      const recs = await this.streamingApi.getRecommendations().catch(() => []);
      const pool = fanartPool(recs.map((r) => r.media)).filter((u) => u !== this.ambient());
      if (!pool.length) return;
      this.ambientAt = Date.now();
      this.ambient.set(pool[Math.floor(Math.random() * pool.length)]);
    } finally {
      this.rolling = false;
    }
  }

  private pathOf(nav: Navigation): string {
    return this.router.serializeUrl(nav.finalUrl ?? nav.extractedUrl);
  }
}

function isPlayer(url: string): boolean {
  return url.startsWith('/watch');
}
