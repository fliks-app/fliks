import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideCheck, LucideX } from '@lucide/angular';
import { ToggleFieldComponent } from '../../shared/components/forms/toggle-field/toggle-field';
import { UsersApiService } from '../../core/services/api/users-api.service';
import { AuthService, ProfileVisibility } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { SocialApiService, SocialUser } from '../../core/services/api/social-api.service';

/** The self-editable social privacy fields — shape shared by the API body and
 *  the local auth-user patch. */
interface SocialPrefs {
  profileVisibility?: ProfileVisibility;
  shareTastes?: boolean;
  shareRecommendations?: boolean;
  shareWatchHistory?: boolean;
  shareLikes?: boolean;
  shareStats?: boolean;
  shareDisabled?: boolean;
}

@Component({
  selector: 'app-account-privacy',
  imports: [TranslateModule, ToggleFieldComponent, LucideCheck, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './privacy.html',
})
export class AccountPrivacyComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly social = inject(SocialApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly publicProfile = signal(false);
  readonly shareTastes = signal(false);
  readonly shareRecommendations = signal(false);
  readonly shareWatchHistory = signal(false);
  readonly shareLikes = signal(false);
  readonly shareStats = signal(false);
  readonly shareDisabled = signal(false);

  readonly requests = signal<SocialUser[]>([]);

  ngOnInit(): void {
    this.syncFromUser();
    void this.loadRequests();
  }

  /** (Re)seed the toggles from the current auth user — also used to revert an
   *  optimistic change when the save fails. */
  private syncFromUser(): void {
    const u = this.auth.user();
    if (!u) return;
    this.publicProfile.set(u.profileVisibility === 'public');
    this.shareTastes.set(u.shareTastes);
    this.shareRecommendations.set(u.shareRecommendations);
    this.shareWatchHistory.set(u.shareWatchHistory);
    this.shareLikes.set(u.shareLikes);
    this.shareStats.set(u.shareStats);
    this.shareDisabled.set(u.shareDisabled);
  }

  private async loadRequests(): Promise<void> {
    try {
      this.requests.set(await this.social.listRequests({ force: true }));
    } catch {
      /* interceptor surfaces errors */
    }
  }

  async onPublicProfileChange(value: boolean): Promise<void> {
    this.publicProfile.set(value);
    await this.persist({ profileVisibility: value ? 'public' : 'private' });
  }

  async onShareTastesChange(value: boolean): Promise<void> {
    this.shareTastes.set(value);
    await this.persist({ shareTastes: value });
  }

  async onShareRecommendationsChange(value: boolean): Promise<void> {
    this.shareRecommendations.set(value);
    await this.persist({ shareRecommendations: value });
  }

  async onShareWatchHistoryChange(value: boolean): Promise<void> {
    this.shareWatchHistory.set(value);
    await this.persist({ shareWatchHistory: value });
  }

  async onShareLikesChange(value: boolean): Promise<void> {
    this.shareLikes.set(value);
    await this.persist({ shareLikes: value });
  }

  async onShareStatsChange(value: boolean): Promise<void> {
    this.shareStats.set(value);
    await this.persist({ shareStats: value });
  }

  async onShareDisabledChange(value: boolean): Promise<void> {
    // Reflect the toggle immediately so the bound value tracks the switch —
    // this is what lets the false reset below register as a real change.
    this.shareDisabled.set(value);
    // Enabling tears down the user's social ties server-side (follows, saved
    // playlists, collaborations, recommendations) — confirm before applying.
    if (value) {
      const confirmed = await this.confirmation.confirm({
        title: this.translate.instant('social.privacy_share_disabled'),
        message: this.translate.instant('social.privacy_share_disabled_confirm'),
        confirmLabel: this.translate.instant('social.privacy_share_disabled_confirm_action'),
        variant: 'danger',
      });
      if (!confirmed) {
        this.shareDisabled.set(false);
        return;
      }
      this.requests.set([]);
    }
    await this.persist({ shareDisabled: value });
  }

  private async persist(patch: SocialPrefs): Promise<void> {
    const u = this.auth.user();
    if (!u) return;
    try {
      await this.api.update(u.id, patch);
      this.auth.patchUser(patch);
      this.toast.success(this.translate.instant('social.privacy_saved'));
    } catch {
      // Revert the optimistic toggle — the server still holds the old value.
      this.syncFromUser();
    }
  }

  async accept(user: SocialUser): Promise<void> {
    await this.social.acceptRequest(user.id);
    this.requests.update((r) => r.filter((u) => u.id !== user.id));
  }

  async reject(user: SocialUser): Promise<void> {
    await this.social.rejectRequest(user.id);
    this.requests.update((r) => r.filter((u) => u.id !== user.id));
  }
}
