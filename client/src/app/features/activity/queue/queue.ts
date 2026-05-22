import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
  OnDestroy,
  viewChild,
  ElementRef,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  DownloadClientsApiService,
  QueueItem,
} from '../../../core/services/api/download-clients-api.service';
import {
  MediaService,
  Media,
} from '../../../core/services/api/media.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  LucideRotateCcw,
  LucideLink2,
  LucideEllipsisVertical,
  LucideTriangleAlert,
  LucideDownload,
  LucideSearch,
  LucideTrash2,
} from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';

@Component({
  selector: 'app-activity-queue',
  imports: [TranslateModule, DecimalPipe, NgClass, RouterLink, FormsModule, ResolveUrlPipe, DropdownMenuComponent, LucideRotateCcw, LucideLink2, LucideEllipsisVertical, LucideTriangleAlert, LucideDownload, LucideSearch, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queue.html',
})
export class ActivityQueueComponent implements OnInit, OnDestroy {
  private readonly downloadApi = inject(DownloadClientsApiService);
  private readonly mediaService = inject(MediaService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  readonly queue = signal<QueueItem[]>([]);
  readonly queueLoading = signal(true);
  readonly queueError = signal('');
  readonly importing = signal(false);

  // Link torrent modal
  readonly linkDialog = viewChild<ElementRef<HTMLDialogElement>>('linkModal');
  readonly linkItem = signal<QueueItem | null>(null);
  readonly linkSearch = signal('');
  readonly linkResults = signal<Media[]>([]);
  readonly linkSearching = signal(false);
  readonly linkSelectedMediaId = signal<number | null>(null);
  readonly linkSaving = signal(false);

  private intervalId: ReturnType<typeof setInterval> | null = null;

  ngOnInit() {
    this.refreshQueue();
    this.intervalId = setInterval(() => this.refreshQueue(), 10_000);
  }

  ngOnDestroy() {
    if (this.intervalId !== null) clearInterval(this.intervalId);
  }

  get hasImportable(): boolean {
    return this.queue().some(
      (q) => q.status === 'Awaiting import' || q.status === 'Import failed',
    );
  }

  async triggerImport() {
    this.importing.set(true);
    try {
      await this.downloadApi.triggerImport();
      setTimeout(() => this.refreshQueue(), 3000);
    } catch { /* ignore */ } finally {
      this.importing.set(false);
    }
  }

  async reimportAndTrigger(item: QueueItem) {
    this.importing.set(true);
    try {
      await this.downloadApi.reimport(item.hash);
      await this.downloadApi.triggerImport();
      this.toast.info(this.translate.instant('activity.import_started'));
      setTimeout(() => this.refreshQueue(), 3000);
    } catch { /* ignore */ } finally {
      this.importing.set(false);
    }
  }

  async removeTorrent(item: QueueItem, deleteFiles: boolean) {
    const msg = deleteFiles
      ? this.translate.instant('activity.confirm_delete_with_files')
      : this.translate.instant('activity.confirm_delete');
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.downloadApi.removeTorrent(item.hash, item.clientId, deleteFiles);
      this.queue.update((q) => q.filter((i) => i.hash !== item.hash));
    } catch { /* ignore */ }
  }

  openLinkModal(item: QueueItem) {
    this.linkItem.set(item);
    this.linkSearch.set(item.name.replace(/\./g, ' ').replace(/\[.*?\]/g, '').trim());
    this.linkResults.set([]);
    this.linkSelectedMediaId.set(null);
    this.linkDialog()?.nativeElement.showModal();
    this.searchMediaForLink();
  }

  async searchMediaForLink() {
    const q = this.linkSearch().trim();
    if (!q) return;
    this.linkSearching.set(true);
    try {
      const res = await this.mediaService.getAll({ q, limit: 10 });
      this.linkResults.set(res.data);
    } finally {
      this.linkSearching.set(false);
    }
  }

  async confirmLink() {
    const item = this.linkItem();
    const mediaId = this.linkSelectedMediaId();
    if (!item || !mediaId) return;
    this.linkSaving.set(true);
    try {
      await this.mediaService.linkTorrent(mediaId, item.hash);
      this.linkDialog()?.nativeElement.close();
      await this.refreshQueue();
    } finally {
      this.linkSaving.set(false);
    }
  }

  async refreshQueue() {
    try {
      const items = await this.downloadApi.getQueue();
      this.queue.set(items);
      this.queueError.set('');
    } catch {
      this.queueError.set(this.translate.instant('activity.queue_error'));
    } finally {
      this.queueLoading.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  formatSpeed(bytesPerSec: number): string {
    return `${this.formatBytes(bytesPerSec)}/s`;
  }

  formatEta(seconds: number): string {
    if (seconds <= 0 || !isFinite(seconds)) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  appStateClass(status: string): string {
    switch (status) {
      case 'Awaiting import':
      case 'Importing': return 'badge-warning';
      case 'Imported': return 'badge-success';
      case 'Quality not upgraded': return 'badge-warning';
      case 'Import failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }
}
