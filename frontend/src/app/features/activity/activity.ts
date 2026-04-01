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
import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  DownloadClientsApiService,
  QueueItem,
} from '../../core/services/api/download-clients-api.service';
import {
  MediaService,
  Media,
  HistoryEntry,
} from '../../core/services/api/media.service';
import {
  SubtitlesApiService,
  SubtitleHistoryEntry,
} from '../../core/services/api/subtitles-api.service';

type Tab = 'queue' | 'history' | 'subtitles';

@Component({
  selector: 'app-activity',
  imports: [TranslateModule, DecimalPipe, DatePipe, NgClass, RouterLink, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './activity.html',
})
export class ActivityComponent implements OnInit, OnDestroy {
  private readonly downloadApi = inject(DownloadClientsApiService);
  private readonly mediaService = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly translate = inject(TranslateService);

  readonly tab = signal<Tab>('queue');

  // Queue
  readonly queue = signal<QueueItem[]>([]);
  readonly queueLoading = signal(true);
  readonly queueError = signal('');
  readonly importing = signal(false);

  // History
  readonly history = signal<HistoryEntry[]>([]);
  readonly historyTotal = signal(0);
  readonly historyPage = signal(1);
  readonly historyLoading = signal(true);
  readonly historyError = signal('');

  // Subtitles
  readonly subHistory = signal<SubtitleHistoryEntry[]>([]);
  readonly subHistoryTotal = signal(0);
  readonly subHistoryPage = signal(1);
  readonly subHistoryLoading = signal(false);
  readonly subHistoryError = signal('');
  readonly subFilterStatus = signal('');
  readonly subFilterLang = signal('');

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
    this.loadHistory();
    this.intervalId = setInterval(() => {
      if (this.tab() === 'queue') this.refreshQueue();
    }, 10_000);
  }

  ngOnDestroy() {
    if (this.intervalId !== null) clearInterval(this.intervalId);
  }

  switchTab(t: Tab) {
    this.tab.set(t);
    if (t === 'history' && this.history().length === 0) this.loadHistory(1);
    if (t === 'subtitles' && this.subHistory().length === 0) this.loadSubHistory(1);
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
      // Wait a bit for processing, then refresh
      setTimeout(() => this.refreshQueue(), 3000);
    } catch {
      // ignore
    } finally {
      this.importing.set(false);
    }
  }

  async removeTorrent(item: QueueItem, deleteFiles: boolean) {
    const msg = deleteFiles
      ? this.translate.instant('activity.confirm_delete_with_files')
      : this.translate.instant('activity.confirm_delete');
    if (!confirm(msg)) return;
    try {
      await this.downloadApi.removeTorrent(item.hash, item.clientId, deleteFiles);
      this.queue.update((q) => q.filter((i) => i.hash !== item.hash));
    } catch {
      // ignore
    }
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
      await this.mediaService.linkTorrent(mediaId, item.name, item.clientId);
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

  async loadHistory(page = 1) {
    this.historyPage.set(page);
    this.historyLoading.set(true);
    try {
      const res = await this.mediaService.getHistory(page, 25);
      this.history.set(res.data);
      this.historyTotal.set(res.total);
      this.historyError.set('');
    } catch {
      this.historyError.set(this.translate.instant('activity.history_error'));
    } finally {
      this.historyLoading.set(false);
    }
  }

  async deleteHistory(entry: HistoryEntry) {
    try {
      await this.mediaService.deleteHistory(entry.id);
      await this.loadHistory(this.historyPage());
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? 'Error');
    }
  }

  async retryImport(entry: HistoryEntry) {
    try {
      await this.mediaService.retryImport(entry.id);
      await this.loadHistory(this.historyPage());
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? 'Error');
    }
  }

  historyStatusClass(status: string): string {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'grabbed': return 'badge-info';
      case 'importing': return 'badge-warning';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  get historyTotalPages(): number {
    return Math.max(1, Math.ceil(this.historyTotal() / 25));
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

  async loadSubHistory(page = 1) {
    this.subHistoryPage.set(page);
    this.subHistoryLoading.set(true);
    this.subHistoryError.set('');
    try {
      const params: Record<string, any> = { page, limit: 25 };
      if (this.subFilterStatus()) params['status'] = this.subFilterStatus();
      if (this.subFilterLang()) params['language'] = this.subFilterLang();
      const res = await this.subtitlesApi.getHistory(params);
      this.subHistory.set(res.data);
      this.subHistoryTotal.set(res.total);
    } catch {
      this.subHistoryError.set(this.translate.instant('activity.subtitle_history_error'));
    } finally {
      this.subHistoryLoading.set(false);
    }
  }

  applySubFilters() {
    this.loadSubHistory(1);
  }

  get subHistoryTotalPages(): number {
    return Math.max(1, Math.ceil(this.subHistoryTotal() / 25));
  }

  subStatusClass(status: string): string {
    switch (status) {
      case 'downloaded': case 'synced': return 'badge-success';
      case 'upgraded': return 'badge-warning';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  stateClass(status: string): string {
    switch (status) {
      case 'Downloading':
      case 'Downloading metadata': return 'badge-info';
      case 'Stalled': return 'badge-warning';
      case 'Importing': return 'badge-warning';
      case 'Seeding':
      case 'Awaiting import': return 'badge-success';
      case 'Paused':
      case 'Stopped':
      case 'Queued': return 'badge-ghost';
      case 'Error':
      case 'Missing files':
      case 'Import failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }
}
