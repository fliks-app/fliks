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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideUserPlus, LucideUserCheck, LucideClock, LucideSettings } from '@lucide/angular';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { SocialApiService, PublicProfile } from '../../core/services/api/social-api.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';

@Component({
  selector: 'app-profile',
  imports: [
    RouterLink,
    TranslateModule,
    MosaicCardComponent,
    MediaCardComponent,
    HorizontalScrollerComponent,
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
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly navbar = inject(NavbarService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly params = toSignal(this.route.paramMap);
  readonly userId = computed(() => Number(this.params()?.get('userId')));

  readonly loading = signal(true);
  readonly profile = signal<PublicProfile | null>(null);
  readonly busy = signal(false);

  readonly avatar = computed(() => initialsAvatar(this.profile()?.username ?? ''));

  /** Name of the first library the viewer can access — genre chips link here,
   *  filtered by the genre. Empty when the viewer has no library access. */
  readonly firstLibraryName = signal('');

  constructor() {
    effect(() => {
      const id = this.userId();
      if (Number.isFinite(id) && id > 0) void this.load(id);
    });
    void this.loadLibraries();
    this.navbar.showBackButton.set(true);
    this.destroyRef.onDestroy(() => this.navbar.showBackButton.set(false));
  }

  private async loadLibraries(): Promise<void> {
    try {
      const libs = await this.librariesApi.list();
      this.firstLibraryName.set(libs[0]?.name ?? '');
    } catch {
      /* interceptor surfaces errors */
    }
  }

  private async load(id: number): Promise<void> {
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

  mediaLink(mediaType: string, mediaId: number): string[] {
    return [mediaType === 'series' ? '/series' : '/movies', String(mediaId)];
  }

  /** True when at least one visible section has something to show. */
  hasContent(p: PublicProfile): boolean {
    return (
      p.playlists.length > 0 ||
      (p.shown.tastes && p.topGenres.length > 0) ||
      (p.shown.recommendations && p.recommendations.length > 0) ||
      (p.shown.recentlyWatched && p.recentlyWatched.length > 0) ||
      (p.shown.likes && p.likes.length > 0)
    );
  }

  openPlaylist(id: number): void {
    void this.router.navigate(['/playlists', id]);
  }

  async follow(): Promise<void> {
    const p = this.profile();
    if (!p || this.busy()) return;
    this.busy.set(true);
    try {
      const res = await this.api.follow(p.id);
      this.profile.update((cur) =>
        cur
          ? {
              ...cur,
              isFollowing: res.status === 'accepted',
              requested: res.status === 'pending',
              followerCount: res.status === 'accepted' ? cur.followerCount + 1 : cur.followerCount,
            }
          : cur,
      );
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
      this.profile.update((cur) =>
        cur
          ? {
              ...cur,
              isFollowing: false,
              requested: false,
              followerCount: cur.isFollowing
                ? Math.max(0, cur.followerCount - 1)
                : cur.followerCount,
            }
          : cur,
      );
      // A private profile becomes non-viewable again once unfollowed; reload
      // so the content sections collapse to the header.
      if (p.visibility === 'private' && !p.isSelf) void this.load(p.id);
    } finally {
      this.busy.set(false);
    }
  }

  editPrivacy(): void {
    void this.router.navigate(['/account/privacy']);
  }
}
