import { Component, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToggleFieldComponent } from '../../shared/components/forms/toggle-field/toggle-field';
import { UsersApiService } from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-account-whats-new',
  imports: [TranslatePipe, ToggleFieldComponent],
  templateUrl: './whats-new.html',
})
export class AccountWhatsNewComponent {
  private readonly api = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly enabled = signal(this.auth.user()?.whatsNewEnabled ?? true);

  async onChange(value: boolean): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.enabled.set(value);
    try {
      await this.api.update(user.id, { whatsNewEnabled: value });
      this.auth.patchUser({ whatsNewEnabled: value });
      this.toast.success(this.translate.instant('common.saved'));
    } catch {
      this.enabled.set(!value);
    }
  }
}
