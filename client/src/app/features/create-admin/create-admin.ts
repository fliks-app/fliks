import { Component, inject, signal } from '@angular/core';
import { AbstractControl, ReactiveFormsModule, FormBuilder, ValidationErrors, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/services/auth.service';

export function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const { password, confirm } = group.value;
  return password && confirm && password !== confirm ? { mismatch: true } : null;
}

/** First-boot page: creates the administrator of a server that has no account yet. */
@Component({
  selector: 'app-create-admin',
  imports: [ReactiveFormsModule, TranslatePipe],
  templateUrl: './create-admin.html',
})
export class CreateAdminComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  readonly loading = signal(false);

  readonly form = this.fb.nonNullable.group(
    {
      username: ['', [Validators.required, Validators.pattern(/\S/)]],
      password: ['', [Validators.required, Validators.minLength(8)]],
      confirm: ['', [Validators.required]],
    },
    { validators: passwordsMatch },
  );

  async onSubmit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    const { username, password } = this.form.getRawValue();
    try {
      await this.auth.createFirstAdmin(username.trim(), password);
      void this.router.navigate(['/'], { replaceUrl: true });
    } catch (err) {
      // 409: another browser finished the setup first.
      if (err instanceof HttpErrorResponse && err.status === 409) {
        void this.router.navigate(['/select-user'], { replaceUrl: true });
        return;
      }
    } finally {
      this.loading.set(false);
    }
  }
}
