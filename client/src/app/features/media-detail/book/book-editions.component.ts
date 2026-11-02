import { Component, OnInit, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { BookEdition } from '../../../core/services/api/books.models';
import { EmailDevice, EmailDevicesApiService } from '../../../core/services/api/email-devices-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { formatClock } from './book-media';

@Component({
  selector: 'app-book-editions',
  imports: [TranslatePipe],
  templateUrl: './book-editions.component.html',
  host: { class: 'block' },
})
export class BookEditionsComponent implements OnInit {
  private readonly mail = inject(EmailDevicesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly editions = input.required<BookEdition[]>();
  readonly devices = signal<EmailDevice[]>([]);

  protected readonly clock = formatClock;

  async ngOnInit(): Promise<void> {
    try {
      const list = await this.mail.list();
      if (list.enabled && list.canSend) this.devices.set(list.devices);
    } catch {
      // No devices listed: the send menu stays hidden.
    }
  }

  /** The devices that accept the edition's format; a text edition with one file can be mailed. */
  targets(e: BookEdition): EmailDevice[] {
    if (e.family !== 'text' || e.fileIds.length !== 1 || !e.format) return [];
    const format = e.format.toLowerCase();
    return this.devices().filter((d) => d.formats.includes(format));
  }

  async send(e: BookEdition, deviceId: string): Promise<void> {
    const device = this.devices().find((d) => d.id === Number(deviceId));
    if (!device) return;
    try {
      await this.mail.send(device.id, e.fileIds[0]);
      this.toast.success(this.translate.instant('books_work.send_queued', { name: device.name }));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }
}
