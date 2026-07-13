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
import {
  ActivatedRoute,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideUserPlus,
  LucideUserCheck,
  LucideClock,
  LucideSettings,
} from '@lucide/angular';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';
import { ProfileContextService } from './profile-context.service';

/**
 * Profile shell: renders the shared header (avatar, counts, follow control) and
 * a tab nav, with the active section swapped through the `<router-outlet>`
 * (overview / followers / following / recommendations). The profile aggregate
 * is loaded once into {@link ProfileContextService} and read by the header here
 * and by the routed children.
 */
@Component({
  selector: 'app-profile',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslateModule,
    LucideUserPlus,
    LucideUserCheck,
    LucideClock,
    LucideSettings,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.html',
})
export class ProfileComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(SocialApiService);
  private readonly navbar = inject(NavbarService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly ctx = inject(ProfileContextService);

  private readonly params = toSignal(this.route.paramMap);
  readonly userId = computed(() => Number(this.params()?.get('userId')));

  readonly profile = this.ctx.profile;
  readonly busy = signal(false);

  readonly avatar = computed(() => initialsAvatar(this.profile()?.username ?? ''));

  constructor() {
    effect(() => {
      const id = this.userId();
      if (Number.isFinite(id) && id > 0) void this.ctx.load(id);
    });
    this.navbar.showBackButton.set(true);
    this.destroyRef.onDestroy(() => this.navbar.showBackButton.set(false));
  }

  async follow(): Promise<void> {
    const p = this.profile();
    if (!p || this.busy()) return;
    this.busy.set(true);
    try {
      const res = await this.api.follow(p.id);
      this.ctx.patch({
        isFollowing: res.status === 'accepted',
        requested: res.status === 'pending',
        followerCount:
          res.status === 'accepted' ? p.followerCount + 1 : p.followerCount,
      });
    } finally {
      this.busy.set(false);
    }
  }

  async unfollow(): Promise<void> {
    const p = this.profile();
    if (!p || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.unfollow(p.id);
      this.ctx.patch({
        isFollowing: false,
        requested: false,
        followerCount: p.isFollowing
          ? Math.max(0, p.followerCount - 1)
          : p.followerCount,
      });
      // A private profile becomes non-viewable again once unfollowed. Return to
      // the overview (so a followers/following child list doesn't linger — its
      // effect keys on userId, which reload() doesn't change) and refresh the
      // aggregate so everything collapses to the header + "private" message.
      if (p.visibility === 'private' && !p.isSelf) {
        void this.router.navigate(['/profile', p.id]);
        this.ctx.reload();
      }
    } finally {
      this.busy.set(false);
    }
  }

  editPrivacy(): void {
    void this.router.navigate(['/account/privacy']);
  }
}
