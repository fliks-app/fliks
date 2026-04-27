import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  /**
   * Username arrives via `?username=` from the user picker. When set we lock
   * the field — the user already chose this account; let them just enter the
   * password. Without it, fall back to the last username on the active server
   * (server history feature) for one-tap return.
   */
  private readonly presetUsername = this.route.snapshot.queryParamMap.get('username');
  readonly usernameLocked = !!this.presetUsername;

  readonly form = this.fb.nonNullable.group({
    username: [
      this.presetUsername ?? this.serverConfig.lastUsernameForActiveServer() ?? '',
      Validators.required,
    ],
    password: ['', Validators.required],
  });

  async onSubmit() {
    if (this.form.invalid) return;

    this.loading.set(true);
    this.error.set('');

    const { username, password } = this.form.getRawValue();
    try {
      // Trim only the username — a password can legitimately contain leading/
      // trailing whitespace and we shouldn't quietly mutate it (Plex/Jellyfin
      // do the same). Whitespace around usernames is almost always a copy-paste
      // artefact that breaks auth.
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

  async changeServer() {
    await this.serverConfig.clear();
    void this.router.navigate(['/setup']);
  }

  goToSelectUser() {
    void this.router.navigate(['/select-user']);
  }
}
