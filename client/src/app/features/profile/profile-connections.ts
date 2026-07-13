import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideUserPlus, LucideUserCheck, LucideClock } from '@lucide/angular';
import { SocialApiService, SocialUser } from '../../core/services/api/social-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';

type ConnectionsMode = 'followers' | 'following';

/** Lists a profile's followers or following (route `data.mode`), each row with
 *  its own follow/unfollow control. */
@Component({
  selector: 'app-profile-connections',
  imports: [RouterLink, TranslateModule, LucideUserPlus, LucideUserCheck, LucideClock],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-connections.html',
})
export class ProfileConnectionsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(SocialApiService);
  private readonly navbar = inject(NavbarService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly params = toSignal(this.route.paramMap);
  private readonly data = toSignal(this.route.data);
  readonly userId = computed(() => Number(this.params()?.get('userId')));
  readonly mode = computed<ConnectionsMode>(() => (this.data()?.['mode'] as ConnectionsMode) ?? 'followers');

  readonly loading = signal(true);
  readonly users = signal<SocialUser[]>([]);
  readonly busyId = signal<number | null>(null);

  readonly titleKey = computed(() =>
    this.mode() === 'followers' ? 'social.followers' : 'social.following_title',
  );

  constructor() {
    effect(() => {
      const id = this.userId();
      const mode = this.mode();
      if (Number.isFinite(id) && id > 0) void this.load(id, mode);
    });
    this.navbar.showBackButton.set(true);
    this.destroyRef.onDestroy(() => this.navbar.showBackButton.set(false));
  }

  avatar(name: string) {
    return initialsAvatar(name);
  }

  private async load(id: number, mode: ConnectionsMode): Promise<void> {
    this.loading.set(true);
    try {
      const list =
        mode === 'followers'
          ? await this.api.listFollowers(id, { force: true })
          : await this.api.listFollowing(id, { force: true });
      // Ignore a stale response if the user/mode changed meanwhile.
      if (this.userId() === id && this.mode() === mode) this.users.set(list);
    } catch {
      if (this.userId() === id && this.mode() === mode) this.users.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private patch(userId: number, patch: Partial<SocialUser>): void {
    this.users.update((list) =>
      list.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
    );
  }

  async follow(u: SocialUser): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(u.id);
    try {
      const res = await this.api.follow(u.id);
      this.patch(u.id, {
        isFollowing: res.status === 'accepted',
        requested: res.status === 'pending',
      });
    } finally {
      this.busyId.set(null);
    }
  }

  async unfollow(u: SocialUser): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(u.id);
    try {
      await this.api.unfollow(u.id);
      this.patch(u.id, { isFollowing: false, requested: false });
    } finally {
      this.busyId.set(null);
    }
  }
}
