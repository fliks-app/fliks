import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UsersApiService } from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-account',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account.html',
})
export class AccountComponent {
  private readonly api = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly saving = signal(false);
  readonly formPassword = signal('');
  readonly formPasswordConfirm = signal('');

  readonly mismatch = computed(
    () => !!this.formPasswordConfirm() && this.formPassword() !== this.formPasswordConfirm(),
  );

  async save() {
    const user = this.auth.user();
    if (!user || !this.formPassword() || this.mismatch()) return;

    this.saving.set(true);
    try {
      await this.api.update(user.id, { password: this.formPassword() });
      this.formPassword.set('');
      this.formPasswordConfirm.set('');
      this.toast.success(this.translate.instant('account.save_success'));
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
