import { Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/services/auth.service';

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
  private readonly translate = inject(TranslateService);

  readonly loading = signal(false);
  readonly error = signal('');

  readonly form = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.pattern(/\S/)]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    confirm: ['', [Validators.required]],
  });

  readonly mismatch = computed(() => {
    const v = this.form.getRawValue();
    return !!v.password && !!v.confirm && v.password !== v.confirm;
  });

  async onSubmit() {
    if (this.form.invalid || this.mismatch()) return;
    this.loading.set(true);
    this.error.set('');
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
      this.error.set(this.translate.instant('create_admin.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
