import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { InputFieldComponent } from '../../shared/components/forms/input-field/input-field';
import { SelectFieldComponent } from '../../shared/components/forms/select-field/select-field';
import {
  DeviceToken,
  DeviceTokenKind,
  DeviceTokensApiService,
  IssuedDeviceToken,
} from '../../core/services/api/device-tokens-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { ToastService } from '../../core/services/toast.service';

/** Tokens for e-readers and reading apps; the plaintext is shown once, at creation or renewal. */
@Component({
  selector: 'app-account-devices',
  imports: [DatePipe, TranslatePipe, InputFieldComponent, SelectFieldComponent],
  templateUrl: './devices.html',
})
export class AccountDevicesComponent implements OnInit {
  private readonly api = inject(DeviceTokensApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly translate = inject(TranslateService);

  readonly kinds: DeviceTokenKind[] = ['opds', 'kosync', 'kobo'];
  readonly devices = signal<DeviceToken[]>([]);
  readonly issued = signal<IssuedDeviceToken | null>(null);
  readonly name = signal('');
  readonly kind = signal<DeviceTokenKind>('opds');
  readonly busy = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.devices.set(await this.api.list());
    } catch {
      // The interceptor surfaces the error; an empty list would read as "no device".
    }
  }

  async create(): Promise<void> {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    try {
      this.issued.set(await this.api.create(name, this.kind()));
      this.name.set('');
      await this.load();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busy.set(false);
    }
  }

  async renew(device: DeviceToken): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('device_tokens.renew_title'),
      message: this.translate.instant('device_tokens.renew_message'),
      confirmLabel: this.translate.instant('device_tokens.renew'),
      variant: 'warning',
    });
    if (!ok) return;
    try {
      this.issued.set(await this.api.renew(device.id));
      this.toast.success(this.translate.instant('device_tokens.renewed'));
      await this.load();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }

  async revoke(device: DeviceToken): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('device_tokens.revoke_title'),
      message: this.translate.instant('device_tokens.revoke_message'),
      confirmLabel: this.translate.instant('device_tokens.revoke'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.revoke(device.id);
      if (this.issued()?.id === device.id) this.issued.set(null);
      this.devices.update((l) => l.filter((d) => d.id !== device.id));
      this.toast.success(this.translate.instant('device_tokens.revoked'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }

  /** The line to put in `.kobo/Kobo/Kobo eReader.conf`. */
  koboEndpoint(token: string): string {
    return `api_endpoint=${new URL(this.serverConfig.resolveUrl(`/kobo/${token}`), location.origin).href}`;
  }

  async copy(token: string): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(token);
      this.toast.success(this.translate.instant('device_tokens.copied'));
    } catch {
      // Clipboard denied: the token stays readable on screen.
    }
  }
}
