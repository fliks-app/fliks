import { Injectable, inject } from '@angular/core';
import { clearRequestCache } from '../interceptors/cache.interceptor';
import { CachingReuseStrategy } from './route-reuse.strategy';

/** Wipes every local "server data" cache so a new session (login/logout, switch user/server, "Vider le cache") never inherits the last view.
 *  Preserved: downloaded media, stored sessions (AuthService owns them) and UI prefs. */
@Injectable({ providedIn: 'root' })
export class ServerCacheService {
  private readonly reuseStrategy = inject(CachingReuseStrategy);

  async clearAll(): Promise<void> {
    await Promise.all([clearRequestCache(), this.clearRouteReuse()]);
  }

  private async clearRouteReuse(): Promise<void> {
    this.reuseStrategy.clear();
  }
}
