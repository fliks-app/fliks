import { Injectable, inject } from '@angular/core';
import { REQUEST_CACHE_DB } from '../interceptors/cache.interceptor';
import { CachingReuseStrategy } from './route-reuse.strategy';

/**
 * Single-call wipe of every "server data" cache the app keeps locally so a
 * fresh session never inherits the previous one's view. Called from:
 *
 * - `AuthService.logout()` / `login()` — different user implies different
 *   permissions, different libraries, different home rows.
 * - User-menu / select-user "Switch user" — same as above.
 * - User-menu / select-user "Change server" — IDs are scoped to the server,
 *   reusing them across servers would surface ghosts.
 * - Storage settings → "Vider le cache" — user-initiated reset.
 *
 * Explicitly preserved: downloaded media (file IDs are server-scoped but
 * the user opted into them), the auth token (until logout), UI prefs
 * (sidebar pinned, player settings, etc.).
 */
@Injectable({ providedIn: 'root' })
export class ServerCacheService {
  private readonly reuseStrategy = inject(CachingReuseStrategy);

  async clearAll(): Promise<void> {
    await Promise.all([
      this.deleteRequestCacheDb(),
      this.clearCachedUser(),
      this.clearRouteReuse(),
    ]);
  }

  private deleteRequestCacheDb(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(REQUEST_CACHE_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        // Another tab still has the DB open — it'll be deleted when that closes.
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private async clearCachedUser(): Promise<void> {
    try { localStorage.removeItem('fliks.cachedUser'); } catch { /* ignore */ }
  }

  private async clearRouteReuse(): Promise<void> {
    this.reuseStrategy.clear();
  }
}
