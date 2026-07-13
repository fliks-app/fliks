import {
  ChangeDetectionStrategy,
  Component,
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
import { AuthService } from '../../core/services/auth.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';
import { ProfileContextService } from './profile-context.service';

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
  private readonly ctx = inject(ProfileContextService);
  private readonly auth = inject(AuthService);

  /** The logged-in user — their own row shows no follow control. */
  readonly myId = computed(() => this.auth.user()?.id ?? 0);

  private readonly data = toSignal(this.route.data);
  // `:userId` lives on the parent route; read it from the shared context
  // rather than this child's paramMap (which wouldn't inherit it).
  readonly userId = this.ctx.userId;
  readonly mode = computed<ConnectionsMode>(() => (this.data()?.['mode'] as ConnectionsMode) ?? 'followers');

  readonly loading = signal(true);
  readonly users = signal<SocialUser[]>([]);
  readonly busyId = signal<number | null>(null);

  constructor() {
    effect(() => {
      const id = this.userId();
      const mode = this.mode();
      if (Number.isFinite(id) && id > 0) void this.load(id, mode);
    });
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
