import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { InputFieldComponent } from '../../shared/components/forms/input-field/input-field';
import { SelectFieldComponent } from '../../shared/components/forms/select-field/select-field';
import {
  BookSend,
  EmailDevice,
  EmailDeviceKind,
  EmailDevicesApiService,
} from '../../core/services/api/email-devices-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';

/** E-reader addresses a book can be mailed to, and the latest mailings. */
@Component({
  selector: 'app-account-email-devices',
  imports: [DatePipe, TranslatePipe, InputFieldComponent, SelectFieldComponent],
  templateUrl: './email-devices.html',
})
export class AccountEmailDevicesComponent implements OnInit {
  private readonly api = inject(EmailDevicesApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly kinds: EmailDeviceKind[] = ['kindle', 'pocketbook', 'other'];
  readonly enabled = signal(true);
  readonly canSend = signal(true);
  readonly devices = signal<EmailDevice[]>([]);
  readonly sends = signal<BookSend[]>([]);
  readonly name = signal('');
  readonly kind = signal<EmailDeviceKind>('kindle');
  readonly address = signal('');
  readonly busy = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [list, sends] = await Promise.all([this.api.list(), this.api.sends()]);
      this.enabled.set(list.enabled);
      this.canSend.set(list.canSend);
      this.devices.set(list.devices);
      this.sends.set(sends);
    } catch {
      // The interceptor surfaces the error; an empty list would read as "no device".
    }
  }

  async create(): Promise<void> {
    const name = this.name().trim();
    const address = this.address().trim();
    if (!name || !address || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.create({ name, kind: this.kind(), address });
      this.name.set('');
      this.address.set('');
      await this.load();
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    } finally {
      this.busy.set(false);
    }
  }

  async remove(device: EmailDevice): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('email_devices.remove_title'),
      message: this.translate.instant('email_devices.remove_message'),
      confirmLabel: this.translate.instant('email_devices.remove'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.remove(device.id);
      this.devices.update((l) => l.filter((d) => d.id !== device.id));
      this.toast.success(this.translate.instant('email_devices.removed'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }
}
