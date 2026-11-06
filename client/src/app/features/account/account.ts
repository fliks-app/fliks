import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { UsersApiService, passwordErrorMessage } from '../../core/services/api/users-api.service';
import { AuthSession, SessionsApiService } from '../../core/services/api/sessions-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-account',
  imports: [DatePipe, FormsModule, TranslatePipe],
  templateUrl: './account.html',
})
export class AccountComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly sessionsApi = inject(SessionsApiService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);

  readonly saving = signal(false);
  readonly formCurrentPassword = signal('');
  readonly formPassword = signal('');
  readonly formPasswordConfirm = signal('');
  readonly sessions = signal<AuthSession[]>([]);

  readonly mismatch = computed(
    () => !!this.formPasswordConfirm() && this.formPassword() !== this.formPasswordConfirm(),
  );

  ngOnInit(): void {
    void this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await this.sessionsApi.list());
    } catch {
      // The interceptor surfaces the error; an empty list would read as "no device".
    }
  }

  async save() {
    const user = this.auth.user();
    if (!user || !this.formPassword() || this.mismatch()) return;

    this.saving.set(true);
    try {
      await this.api.changePassword(user.id, this.formPassword(), this.formCurrentPassword());
      this.formCurrentPassword.set('');
      this.formPassword.set('');
      this.formPasswordConfirm.set('');
      this.toast.success(this.translate.instant('account.save_success'));
      void this.loadSessions();
    } catch (err) {
      this.toast.error(passwordErrorMessage(err, this.translate));
    } finally {
      this.saving.set(false);
    }
  }

  async revoke(session: AuthSession): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('account.sessions.revoke_title'),
      message: this.translate.instant('account.sessions.revoke_message'),
      confirmLabel: this.translate.instant('account.sessions.revoke'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.sessionsApi.revoke(session.id);
      this.sessions.update((l) => l.filter((s) => s.id !== session.id));
      this.toast.success(this.translate.instant('account.sessions.revoked'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }
}
