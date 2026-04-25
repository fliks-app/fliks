import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
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

  readonly isNative = Capacitor.isNativePlatform();

  readonly error = signal('');
  readonly loading = signal(false);

  readonly form = this.fb.nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required],
  });

  async onSubmit() {
    if (this.form.invalid) return;

    this.loading.set(true);
    this.error.set('');

    const { username, password } = this.form.getRawValue();
    try {
      await this.auth.login(username, password);
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
}
