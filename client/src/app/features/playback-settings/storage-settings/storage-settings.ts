import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../core/services/toast.service';
import { DownloadManagerService } from '../../../core/services/download-manager.service';
import { DownloadCacheService } from '../../../core/services/download-cache.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

const API_CACHE_DB = 'fliks-api-cache';

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

  readonly clearing = signal(false);
  readonly deleting = signal(false);

  async clearCache() {
    this.clearing.set(true);
    try {
      // Delete the IndexedDB API cache
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(API_CACHE_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // DB in use — will clear on next open
      });
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
