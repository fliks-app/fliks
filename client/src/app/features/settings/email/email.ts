import { Component, OnInit, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { InputFieldComponent } from '../../../shared/components/forms/input-field/input-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { EmailDevicesApiService } from '../../../core/services/api/email-devices-api.service';
import { SettingsApiService, settingsSecretsSet } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';

const DEFAULT_MAX_MB = '50';

/** The SMTP account books are mailed from; the password is write-only. */
@Component({
  selector: 'app-email-settings',
  imports: [TranslatePipe, InputFieldComponent, SelectFieldComponent],
  templateUrl: './email.html',
})
export class EmailSettingsComponent implements OnInit {
  private readonly settings = inject(SettingsApiService);
  private readonly api = inject(EmailDevicesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly host = signal('');
  readonly port = signal('');
  readonly security = signal('starttls');
  readonly username = signal('');
  readonly password = signal('');
  readonly passwordStored = signal(false);
  readonly from = signal('');
  readonly maxMb = signal(DEFAULT_MAX_MB);
  readonly testTo = signal('');
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const all = await this.settings.getAll();
      this.host.set(all['smtp_host'] ?? '');
      this.port.set(all['smtp_port'] ?? '');
      this.security.set(all['smtp_security'] || 'starttls');
      this.username.set(all['smtp_username'] ?? '');
      this.from.set(all['smtp_from'] ?? '');
      this.maxMb.set(all['smtp_max_attachment_mb'] || DEFAULT_MAX_MB);
      this.passwordStored.set(settingsSecretsSet(all).includes('smtp_password'));
    } catch {
      this.toast.error(this.translate.instant('settings.email.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      // A blank password keeps the stored one.
      await this.settings.setBulk({
        smtp_host: this.host().trim(),
        smtp_port: this.port().trim(),
        smtp_security: this.security(),
        smtp_username: this.username().trim(),
        smtp_password: this.password(),
        smtp_from: this.from().trim(),
        smtp_max_attachment_mb: this.maxMb().trim(),
      });
      this.passwordStored.update((s) => s || !!this.password());
      this.password.set('');
      this.toast.success(this.translate.instant('settings.email.saved'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busy.set(false);
    }
  }

  async test(): Promise<void> {
    const to = this.testTo().trim();
    if (!to || this.busy()) return;
    this.busy.set(true);
    this.testResult.set(null);
    try {
      this.testResult.set(await this.api.test(to));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busy.set(false);
    }
  }
}
