import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { InputFieldComponent } from '../../shared/components/forms/input-field/input-field';
import { MultiSelectComponent, MultiSelectOption } from '../../shared/components/forms/multi-select/multi-select';
import { SelectFieldComponent } from '../../shared/components/forms/select-field/select-field';
import {
  BookSend,
  EmailDevice,
  EmailDeviceKind,
  EmailDevicesApiService,
} from '../../core/services/api/email-devices-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';

/** The formats the server accepts for a mailed book. */
const FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz'];
const DEFAULT_FORMATS = ['epub', 'pdf'];

/** E-reader addresses a book can be mailed to, and the latest mailings. */
@Component({
  selector: 'app-account-email-devices',
  imports: [DatePipe, TranslatePipe, InputFieldComponent, SelectFieldComponent, MultiSelectComponent],
  templateUrl: './email-devices.html',
})
export class AccountEmailDevicesComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(EmailDevicesApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** `other` takes any address, so the server keeps it to who manages settings. */
  readonly kinds: EmailDeviceKind[] = this.auth.hasPermission('settings.access')
    ? ['kindle', 'pocketbook', 'other']
    : ['kindle', 'pocketbook'];
  readonly enabled = signal(true);
  readonly canSend = signal(true);
  readonly devices = signal<EmailDevice[]>([]);
  readonly sends = signal<BookSend[]>([]);
  readonly name = signal('');
  readonly kind = signal<EmailDeviceKind>('kindle');
  readonly address = signal('');
  readonly formats = signal<string[]>([...DEFAULT_FORMATS]);
  readonly formatOptions: MultiSelectOption<string>[] = FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }));
  /** The device the form edits, or null when it adds one. */
  readonly editing = signal<number | null>(null);
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

  edit(device: EmailDevice): void {
    this.editing.set(device.id);
    this.name.set(device.name);
    this.kind.set(device.kind);
    this.address.set(device.address);
    this.formats.set([...device.formats]);
  }

  cancelEdit(): void {
    this.editing.set(null);
    this.name.set('');
    this.kind.set('kindle');
    this.address.set('');
    this.formats.set([...DEFAULT_FORMATS]);
  }

  async save(): Promise<void> {
    const name = this.name().trim();
    const address = this.address().trim();
    const formats = this.formats();
    if (!name || !address || !formats.length || this.busy()) return;
    const body = { name, kind: this.kind(), address, formats };
    const id = this.editing();
    this.busy.set(true);
    try {
      if (id === null) await this.api.create(body);
      else {
        await this.api.update(id, body);
        this.toast.success(this.translate.instant('email_devices.updated'));
      }
      this.cancelEdit();
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
      if (this.editing() === device.id) this.cancelEdit();
      this.devices.update((l) => l.filter((d) => d.id !== device.id));
      this.toast.success(this.translate.instant('email_devices.removed'));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }
}
