import { Injectable, inject, signal } from '@angular/core';
import {
  PublicProfile,
  SocialApiService,
} from '../../core/services/api/social-api.service';

/** Profile state for the `profile/:userId` subtree, provided at the parent route so the header and children share one fetch and see follow/unfollow changes. */
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
      const profile = await this.api.getProfile(id, { force: true });
      if (this.userId() === id) this.profile.set(profile);
    } catch {
      // Global interceptor surfaces the error (404 for a hidden profile).
      if (this.userId() === id) this.profile.set(null);
    } finally {
      if (this.userId() === id) this.loading.set(false);
    }
  }

  patch(patch: Partial<PublicProfile>): void {
    this.profile.update((p) => (p ? { ...p, ...patch } : p));
  }

  reload(): void {
    void this.load(this.userId());
  }
}
