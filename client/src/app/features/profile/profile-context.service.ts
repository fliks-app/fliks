import { Injectable, inject, signal } from '@angular/core';
import {
  PublicProfile,
  SocialApiService,
} from '../../core/services/api/social-api.service';

/**
 * Shared profile state for the `profile/:userId` route subtree. Provided at the
 * parent route so the header (parent) and the routed children (overview,
 * followers/following, recommendations) read the same loaded aggregate from a
 * single fetch, and follow/unfollow mutations are reflected everywhere.
 */
@Injectable()
export class ProfileContextService {
  private readonly api = inject(SocialApiService);

  readonly userId = signal(0);
  readonly loading = signal(true);
  readonly profile = signal<PublicProfile | null>(null);

  async load(id: number): Promise<void> {
    this.userId.set(id);
    this.loading.set(true);
    try {
      this.profile.set(await this.api.getProfile(id, { force: true }));
    } catch {
      // Global interceptor surfaces the error (404 for a hidden profile).
      this.profile.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  patch(patch: Partial<PublicProfile>): void {
    this.profile.update((p) => (p ? { ...p, ...patch } : p));
  }

  reload(): void {
    void this.load(this.userId());
  }
}
