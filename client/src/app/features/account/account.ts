import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { OidcApiService, OidcIdentity } from '../../core/services/api/oidc-api.service';
import { UsersApiService, passwordErrorMessage } from '../../core/services/api/users-api.service';
import { AuthSession, SessionsApiService } from '../../core/services/api/sessions-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { parseDeviceLabel } from '../../core/utils/format-device-label';

/** The server's translation key for a sensitive change that needs a fresh sign-in. */
const RECENT_SIGN_IN = 'account.recent_sign_in_required';

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
  private readonly oidcApi = inject(OidcApiService);

  readonly saving = signal(false);
  readonly formCurrentPassword = signal('');
  readonly linkPassword = signal('');
  readonly formPassword = signal('');
  readonly formPasswordConfirm = signal('');
  readonly sessions = signal<AuthSession[]>([]);

  readonly mismatch = computed(
    () => !!this.formPasswordConfirm() && this.formPassword() !== this.formPasswordConfirm(),
  );

  readonly identities = signal<OidcIdentity[]>([]);
  readonly hasPassword = signal(true);
  readonly linking = signal<number | null>(null);
  /** With password login restricted to admins, a non-admin has no use for a password. */
  readonly passwordHidden = computed(
    () => this.auth.passwordLogin() === 'admins' && !this.auth.user()?.isAdmin,
  );
  /** Providers this shell can complete and the user is not linked to yet. */
  private readonly unlinked = computed(() => {
    const linked = new Set(this.identities().map((i) => i.providerId));
    return this.auth.ssoProviders().filter((p) => !linked.has(p.id));
  });
  /** A link started from another host name could not come back to this session. */
  readonly linkBlocked = computed(() => this.auth.ssoOtherOrigin() && this.unlinked().length > 0);
  readonly linkable = computed(() => (this.auth.ssoOtherOrigin() ? [] : this.unlinked()));
  readonly lastMethod = computed(() => this.identities().length === 1 && !this.hasPassword());

  async ngOnInit() {
    void this.loadSessions();
    await this.auth.oidcInfo();
    await this.loadIdentities();
  }

  private async loadIdentities() {
    try {
      const res = await this.oidcApi.identities();
      this.identities.set(res.identities);
      this.hasPassword.set(res.hasPassword);
    } catch {
      this.identities.set([]);
    }
  }

  async link(providerId: number) {
    this.linking.set(providerId);
    try {
      await this.auth.oidcSignIn(providerId, { link: true, currentPassword: this.linkPassword() });
    } catch (err) {
      this.failedSensitive(err);
    } finally {
      this.linking.set(null);
    }
  }

  /** A recent-sign-in refusal offers the sign-in again, then comes back here. */
  private failedSensitive(err: unknown) {
    const message = passwordErrorMessage(err, this.translate);
    if (err instanceof HttpErrorResponse && err.status === 403 && err.error?.message === RECENT_SIGN_IN) {
      this.toast.info(message, 8000, {
        label: this.translate.instant('account.sign_in_again'),
        run: () => {
          this.auth.returnAfterSignIn('/account');
          void this.auth.logout();
        },
      });
    } else {
      this.toast.error(message);
    }
  }

  async unlink(providerId: number) {
    try {
      await this.oidcApi.unlink(providerId);
      await this.loadIdentities();
    } catch {
      // handled by global error interceptor
    }
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
      await this.api.update(
        user.id,
        { password: this.formPassword(), currentPassword: this.formCurrentPassword() || undefined },
        { skipErrorToast: true },
      );
      this.formCurrentPassword.set('');
      this.formPassword.set('');
      this.formPasswordConfirm.set('');
      this.toast.success(this.translate.instant('account.save_success'));
      void this.loadSessions();
      void this.loadIdentities();
    } catch (err) {
      this.failedSensitive(err);
    } finally {
      this.saving.set(false);
    }
  }

  deviceLabel(session: AuthSession): string {
    const label = parseDeviceLabel(session.userAgent);
    return label
      ? this.translate.instant(label.key, label.params)
      : this.translate.instant('account.sessions.unknown_device');
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
