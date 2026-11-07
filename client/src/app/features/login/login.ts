import { Component, signal, inject, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from '../../core/services/auth.service';
import { oidcErrorText } from '../../core/services/oidc';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SsoButtonsComponent } from '../../shared/components/sso-buttons';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, TranslatePipe, SsoButtonsComponent],
  templateUrl: './login.html',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly route = inject(ActivatedRoute);

  readonly isNative = Capacitor.isNativePlatform();

  readonly error = signal('');
  readonly loading = signal(false);
  /** False when the picker would be empty (roster hidden by the admin): it would bounce back here. */
  readonly canPickUser = signal(true);

  /** `?username=` from the user picker locks the field to the chosen account; else falls back to the active server's last username. */
  private readonly presetUsername = this.route.snapshot.queryParamMap.get('username');
  readonly usernameLocked = !!this.presetUsername;

  readonly form = this.fb.nonNullable.group({
    username: [
      this.presetUsername ?? this.serverConfig.lastUsernameForActiveServer() ?? '',
      Validators.required,
    ],
    password: ['', Validators.required],
  });

  /** Open once an administrator asked for the password form behind the SSO buttons. */
  readonly adminSignIn = signal(!!this.presetUsername);
  readonly sso = this.auth.ssoProviders;
  /** With `passwordLogin = admins` the page leads with SSO and folds the form, unless no button can work here. */
  readonly passwordFolded = computed(
    () => this.auth.passwordLogin() === 'admins' && this.sso().length > 0 && !this.adminSignIn(),
  );

  constructor() {
    // The route is reused when a failed sign-in lands here again, so the error is read from the stream.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((q) => {
      if (!q.get('oidcError') && !q.get('state')) return;
      if (q.get('oidcError')) this.error.set(oidcErrorText(this.translate, q.get('oidcError')));
      // The message is shown once: keep `oidcError` (and the provider's logout `state`) out of the history entry.
      void this.router.navigate([], {
        queryParams: { oidcError: null, state: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
    void this.startSso();
    void this.auth
      .listUsersPublic()
      .then((users) => this.canPickUser.set(users.length > 0 || this.auth.resumableSessions().length > 0))
      .catch(() => undefined);
  }

  /** `?sso=<id>` is the origin redirect of the SSO button; else the configured auto-launch. */
  private async startSso(): Promise<void> {
    const query = this.route.snapshot.queryParamMap;
    const wanted = Number(query.get('sso'));
    await this.auth.oidcInfo();
    if (wanted) {
      // Out of the history entry, so coming back from the provider page does not start it again.
      await this.router.navigate([], { queryParams: { sso: null }, queryParamsHandling: 'merge', replaceUrl: true });
      await this.auth.oidcBegin(wanted).catch(() => undefined);
      return;
    }
    this.auth.oidcAutoLaunch(query.get('autoLaunch') === '0' || !!query.get('oidcError'));
  }

  async onSubmit() {
    if (this.form.invalid) return;

    this.loading.set(true);
    this.error.set('');

    const { username, password } = this.form.getRawValue();
    try {
      await this.auth.login(username.trim(), password);
      this.loading.set(false);
      void this.router.navigate(['/'], { replaceUrl: true });
    } catch (err: unknown) {
      this.loading.set(false);
      const httpErr = err as { error?: { message?: string } };
      this.error.set(
        httpErr.error?.message ?? this.translate.instant('login.error'),
      );
    }
  }

  /** Keep the stored server URL and sessions: /setup is a picker, not a reset. */
  changeServer() {
    void this.router.navigate(['/setup']);
  }

  goToSelectUser() {
    void this.router.navigate(['/select-user'], { queryParams: { autoLaunch: 0 } });
  }
}
