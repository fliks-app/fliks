import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ToggleFieldComponent } from '../../shared/components/forms/toggle-field/toggle-field';
import {
  UpdateUserBody,
  UsersApiService,
} from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-account-spoilers',
  imports: [TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './spoilers.html',
})
export class AccountSpoilersComponent {
  private readonly api = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly hideSpoilers = signal(false);
  readonly hideStills = signal(true);
  readonly hideOverviews = signal(true);
  readonly hideTitles = signal(true);

  constructor() {
    this.syncFromUser();
  }

  /** (Re)seed the toggles from the auth user — also reverts a failed save. */
  private syncFromUser(): void {
    const u = this.auth.user();
    if (!u) return;
    this.hideSpoilers.set(u.hideSpoilers);
    this.hideStills.set(u.spoilerHideStills);
    this.hideOverviews.set(u.spoilerHideOverviews);
    this.hideTitles.set(u.spoilerHideTitles);
  }

  async onHideSpoilersChange(value: boolean): Promise<void> {
    this.hideSpoilers.set(value);
    await this.persist({ hideSpoilers: value });
  }

  async onHideStillsChange(value: boolean): Promise<void> {
    this.hideStills.set(value);
    await this.persist({ spoilerHideStills: value });
  }

  async onHideOverviewsChange(value: boolean): Promise<void> {
    this.hideOverviews.set(value);
    await this.persist({ spoilerHideOverviews: value });
  }

  async onHideTitlesChange(value: boolean): Promise<void> {
    this.hideTitles.set(value);
    await this.persist({ spoilerHideTitles: value });
  }

  private async persist(patch: UpdateUserBody): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.api.update(user.id, patch);
      this.auth.patchUser(patch);
      this.toast.success(this.translate.instant('spoilers.saved'));
    } catch {
      // Revert the optimistic toggle — the server still holds the old value.
      this.syncFromUser();
    }
  }
}
