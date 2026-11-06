import { Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { UsersApiService, passwordErrorMessage } from '../../core/services/api/users-api.service';

/** Mandatory password reset page for users flagged `requirePasswordChange`; no cancel path, and passwordChangeGuard bounces every other URL here. */
@Component({
  selector: 'app-forced-password-change',
  imports: [ReactiveFormsModule, TranslatePipe],
  templateUrl: './forced-password-change.html',
})
export class ForcedPasswordChangeComponent {
  private readonly auth = inject(AuthService);
  private readonly api = inject(UsersApiService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(false);
  readonly error = signal('');

  readonly form = this.fb.nonNullable.group({
    current: [''],
    password: ['', [Validators.required, Validators.minLength(8)]],
    confirm: ['', [Validators.required]],
  });

  readonly mismatch = computed(() => {
    const v = this.form.getRawValue();
    return !!v.password && !!v.confirm && v.password !== v.confirm;
  });

  async onSubmit() {
    if (this.form.invalid || this.mismatch()) return;
    const user = this.auth.user();
    if (!user) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const { current, password } = this.form.getRawValue();
      await this.api.update(
        user.id,
        { password, currentPassword: current || undefined },
        { skipErrorToast: true },
      );
      // Force-refresh /auth/me: backend clears `requirePasswordChange` and hydrateFromServer early-returns when a user is cached.
      await this.auth.refreshUser();
      void this.router.navigate(['/'], { replaceUrl: true });
    } catch (err) {
      this.error.set(passwordErrorMessage(err, this.translate));
    } finally {
      this.loading.set(false);
    }
  }
}
