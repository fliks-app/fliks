import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { BookEdition } from '../../../core/services/api/books.models';
import { EmailDevice, EmailDevicesApiService } from '../../../core/services/api/email-devices-api.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { DownloadManagerService } from '../../../core/services/download-manager.service';
import { DeviceService } from '../../../core/services/device.service';
import { ToastService } from '../../../core/services/toast.service';
import { deliverFiles } from '../../../core/plugins/save-file.plugin';
import { bookDownloadTarget, editionFileNames, formatClock, offlinable } from './book-media';

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

  private readonly device = inject(DeviceService);
  private readonly streaming = inject(StreamingApiService);
  private readonly offline = inject(DownloadManagerService);

  readonly editions = input.required<BookEdition[]>();
  readonly mediaId = input.required<number>();
  readonly title = input('');
  readonly artist = input('');
  readonly devices = signal<EmailDevice[]>([]);

  protected readonly clock = formatClock;
  protected readonly native = Capacitor.isNativePlatform();
  protected readonly canOffline = (e: BookEdition) => !this.device.isTv() && offlinable(e);
  protected readonly offlineTask = (e: BookEdition) => this.offline.tasks().find((t) => t.book?.itemId === e.itemId);
  protected readonly canDeliver = (e: BookEdition) => !this.device.isTv() && e.hasFile && e.fileIds.length > 0;

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

  /** The edition's files straight from the server: browser downloads, or the share sheet on mobile. */
  async deliver(e: BookEdition): Promise<void> {
    const names = editionFileNames(this.title(), e);
    try {
      await deliverFiles(e.fileIds.map((id, i) => ({ url: this.streaming.getOriginalDownloadUrl(id), name: names[i] })));
    } catch {
      this.toast.error(this.translate.instant('books_work.download_failed'));
    }
  }

  /** Keeps the edition on the device, or removes the copy that is there. */
  async toggleOffline(e: BookEdition): Promise<void> {
    const task = this.offlineTask(e);
    try {
      if (task) await this.offline.deleteDownload(task);
      if (task?.status !== 'ready') {
        await this.offline.createBookDownload(
          bookDownloadTarget({ mediaId: this.mediaId(), title: this.title(), artist: this.artist() }, e),
        );
      }
    } catch {
      this.toast.error(this.translate.instant('books_work.download_failed'));
    }
  }
}
