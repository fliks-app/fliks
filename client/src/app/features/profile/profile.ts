import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideUserPlus,
  LucideUserCheck,
  LucideClock,
  LucideSettings,
  LucideCamera,
} from '@lucide/angular';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { UsersApiService } from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ProfileContextService } from './profile-context.service';
import { AvatarEditorComponent } from './avatar-editor/avatar-editor';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';

/**
 * Profile shell: renders the shared header (avatar, counts, follow control) and
 * a tab nav, with the active section swapped through the `<router-outlet>`
 * (overview / followers / following / recommendations). The profile aggregate
 * is loaded once into {@link ProfileContextService} and read by the header here
 * and by the routed children.
 */
@Component({
  selector: 'app-profile',
  imports: [UserAvatarComponent, 
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslatePipe,
    LucideUserPlus,
    LucideUserCheck,
    LucideClock,
    LucideSettings,
    LucideCamera,
    AvatarEditorComponent,
  ],
  templateUrl: './profile.html',
})
export class ProfileComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(SocialApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly navbar = inject(NavbarService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly ctx = inject(ProfileContextService);

  private readonly editor = viewChild(AvatarEditorComponent);

  private readonly params = toSignal(this.route.paramMap);
  readonly userId = computed(() => Number(this.params()?.get('userId')));

  readonly profile = this.ctx.profile;
  readonly busy = signal(false);


  constructor() {
    effect(() => {
      const id = this.userId();
      if (Number.isFinite(id) && id > 0) void this.ctx.load(id);
    });
    effect(() => {
      const name = this.profile()?.username;
      if (name) this.navbar.setPageTitle(name);
    });
    this.navbar.showBackButton.set(true);
    this.destroyRef.onDestroy(() => {
      this.navbar.showBackButton.set(false);
      this.navbar.clearPageTitle();
    });
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

  /** A file was picked from the hidden input — validate and open the cropper. */
  onAvatarPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.toast.error(this.translate.instant('social.avatar_invalid'));
      return;
    }
    this.editor()?.open(file);
  }

  /** The cropper produced a square JPEG — upload it and reflect it live. */
  async onAvatarCropped(blob: Blob): Promise<void> {
    try {
      const res = await this.usersApi.uploadAvatar(blob);
      this.ctx.patch({ avatar: res.avatar });
      this.auth.patchUser({ avatar: res.avatar });
      this.toast.success(this.translate.instant('social.avatar_updated'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }

  async removeAvatar(): Promise<void> {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('social.avatar_remove'),
      message: this.translate.instant('social.avatar_remove_confirm'),
      confirmLabel: this.translate.instant('social.avatar_remove'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await this.usersApi.deleteAvatar();
      this.ctx.patch({ avatar: res.avatar });
      this.auth.patchUser({ avatar: res.avatar });
      this.toast.success(this.translate.instant('social.avatar_removed'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }
}
