import { Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { UsersApiService } from '../../core/services/api/users-api.service';

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
      await this.api.update(user.id, { password: this.form.getRawValue().password });
      // Force-refresh /auth/me: backend clears `requirePasswordChange` and hydrateFromServer early-returns when a user is cached.
      await this.auth.refreshUser();
      void this.router.navigate(['/'], { replaceUrl: true });
    } catch {
      this.error.set(this.translate.instant('forced_password_change.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
