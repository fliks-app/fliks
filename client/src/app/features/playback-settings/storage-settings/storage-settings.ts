import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../core/services/toast.service';
import { DownloadManagerService } from '../../../core/services/download-manager.service';
import { DownloadCacheService } from '../../../core/services/download-cache.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ServerCacheService } from '../../../core/services/server-cache.service';
import {
  DownloadSettingsService,
  MAX_CONCURRENT_CHOICES,
} from '../../../core/services/download-settings.service';
import { DeviceService } from '../../../core/services/device.service';

@Component({
  selector: 'app-storage-settings',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './storage-settings.html',
})
export class StorageSettingsPageComponent {
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dlManager = inject(DownloadManagerService);
  private readonly dlCache = inject(DownloadCacheService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly serverCache = inject(ServerCacheService);
  private readonly downloadSettings = inject(DownloadSettingsService);
  private readonly device = inject(DeviceService);

  /** The desktop shell downloads through its own service, which this cap does
   *  not reach — don't offer a control that wouldn't do anything there. */
  readonly showConcurrency = !this.device.isDesktopNative();
  readonly concurrencyChoices = MAX_CONCURRENT_CHOICES;
  readonly maxConcurrent = this.downloadSettings.maxConcurrent;

  onMaxConcurrentChange(value: string) {
    this.downloadSettings.setMaxConcurrent(Number(value));
  }

  readonly clearing = signal(false);
  readonly deleting = signal(false);

  async clearCache() {
    this.clearing.set(true);
    try {
      await this.serverCache.clearAll();
      this.toast.success(this.translate.instant('storage_settings.cache_cleared'));
    } catch {
      this.toast.error(this.translate.instant('common.error'));
    } finally {
      this.clearing.set(false);
    }
  }

  async deleteAllDownloads() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('storage_settings.delete_downloads_confirm'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;

    this.deleting.set(true);
    try {
      const tasks = this.dlCache.load();
      for (const task of tasks) {
        await this.dlManager.deleteDownload(task);
      }
      this.toast.success(this.translate.instant('storage_settings.downloads_deleted'));
    } catch {
      this.toast.error(this.translate.instant('common.error'));
    } finally {
      this.deleting.set(false);
    }
  }
}
