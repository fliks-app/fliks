import { Injectable, computed, inject, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';

/**
 * localStorage-key suffix isolating device-local state to the current
 * (server, user) pair: a shared device never leaks one account's data into
 * another's, and ids that collide across servers can't cross-surface.
 */
@Injectable({ providedIn: 'root' })
export class StorageScopeService {
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);

  /** Reactive scope key — read it from an effect to re-hydrate on login,
   *  logout or server switch. */
  readonly scope = computed(
    () => `${this.serverConfig.serverUrl()}::${this.auth.user()?.id ?? 0}`,
  );

  /** Same value read untracked, so it is safe to call from an effect that also
   *  writes the state keyed by it without creating an invalidation loop. */
  suffix(): string {
    return untracked(this.scope);
  }

  /** No signed-in account means no scope to write into: a write between two
   *  sessions would land in a `::0` bucket nobody reads. */
  canPersist(): boolean {
    return untracked(() => !!this.auth.user());
  }
}
