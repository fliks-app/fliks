import { Component, signal, computed, inject, effect } from '@angular/core';
import { Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { DownloadTask } from '../../core/services/download-cache.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { isPausable, isTransferring } from '../../core/services/download-status';
import { DownloadNotificationService } from '../../core/services/download-notification.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import {
  LucideDownload,
  LucideTrash2,
  LucidePlay,
  LucideAlertCircle,
  LucideRotateCcw,
  LucideListChecks,
  LucideChevronRight,
  LucidePause,
  LucideX,
} from '@lucide/angular';
import { RouterLink } from '@angular/router';
import { CollapseComponent } from '../../shared/components/collapse/collapse';
import { ToastService } from '../../core/services/toast.service';
import { formatBytes } from '../../shared/utils/download-format';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { SeasonLabelPipe } from '../../core/pipes/season-label.pipe';
import { AutoDownloadService } from '../../core/services/auto-download.service';
import { AutoDownloadRuleComponent } from '../../shared/components/auto-download-rule/auto-download-rule';
import { groupDownloads } from './downloads-grouping';
import { isMediaKind, mediaDetailLink } from '../../core/media-kinds';

const openGroupKeys = signal<ReadonlySet<string>>(new Set());

/** Downloads page: renders the manager's `tasks` signal. */
@Component({
  selector: 'app-downloads',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    CachedSrcDirective,
    TranslatePipe,
    AutoDownloadRuleComponent,
    ResolveUrlPipe,
    LucideDownload,
    LucideTrash2,
    LucidePlay,
    LucideAlertCircle,
    LucideRotateCcw,
    LucideListChecks,
    LucideChevronRight,
    LucidePause,
    LucideX,
    SeasonLabelPipe,
    CollapseComponent,
  ],
  templateUrl: './downloads.html',
})
export class DownloadsComponent {
  private readonly dlManager = inject(DownloadManagerService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly notif = inject(DownloadNotificationService);

  /** Ids being re-queued, so the button can't be double-tapped into two
   *  downloads of the same file. */
  readonly retrying = signal<ReadonlySet<number>>(new Set());

  protected readonly emptySelection: ReadonlySet<number> = new Set();
  readonly selectMode = signal(false);
  /** Groups toggled away from their default (shows closed, a lone season open); app-wide so a trip to the player keeps them. */
  protected readonly openKeys = openGroupKeys;

  protected toggleOpen(key: string): void {
    this.openKeys.update((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }
  readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  readonly selectedTasks = computed(() => this.items().filter((t) => this.selectedIds().has(t.id)));
  readonly selectedFailed = computed(() => this.selectedTasks().filter((t) => t.status === 'failed'));

  protected readonly formatBytes = formatBytes;


  readonly items = this.dlManager.tasks;

  protected readonly auto = inject(AutoDownloadService);
  readonly entries = computed(() => groupDownloads(this.items()));
  readonly pausable = computed(() => this.items().filter((t) => isPausable(t.status)));
  readonly paused = computed(() => this.items().filter((t) => t.status === 'paused'));

  protected readonly freeBytes = signal<number | null>(null);
  private readonly settled = computed(() => `${this.items().filter((t) => t.status === 'ready').length}:${this.items().length}`);
  private readonly freeSpaceEffect = effect(() => {
    this.settled();
    void this.notif.getFreeSpace().then((s) => this.freeBytes.set(s?.freeBytes ?? null));
  });

  protected readonly isPausable = (task: DownloadTask) => isPausable(task.status);
  protected readonly isTransferring = (task: DownloadTask) => isTransferring(task.status);

  pauseItem(task: DownloadTask) {
    void this.dlManager.pauseDownload(task);
  }

  resumeItem(task: DownloadTask) {
    void this.dlManager.resumeDownload(task);
  }

  pauseAll() {
    for (const t of this.pausable()) this.pauseItem(t);
  }

  resumeAll() {
    for (const t of this.paused()) this.resumeItem(t);
  }

  /** Detail page of the episode (or the movie) a download belongs to. */
  detailRoute(task: DownloadTask): string[] | null {
    if (!task.mediaId) return null;
    if (task.episodeId != null) return ['/series', String(task.mediaId), 'episode', String(task.episodeId)];
    const type = task.media?.type;
    const kind = isMediaKind(type) ? type : undefined;
    return mediaDetailLink(kind ?? 'movie', task.mediaId);
  }
  readonly totalBytes = computed(() => this.items().reduce((n, t) => n + (t.sizeBytes ?? 0), 0));

  deleteItem(task: DownloadTask) {
    return this.deleteMany([task], this.translate.instant('downloads.confirm_delete'));
  }

  /** One confirmation, then each task in turn; failures are counted so one bad delete doesn't stop the rest. */
  async deleteMany(tasks: DownloadTask[], message: string) {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message,
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.dlManager.deleteDownload(task);
        this.selectedIds.update((s) => {
          const next = new Set(s);
          next.delete(task.id);
          return next;
        });
      } catch {
        failed++;
      }
    }
    if (failed) {
      this.toast.warning(this.translate.instant('bulk.partial', { done: tasks.length - failed, failed }));
    }
  }

  deleteGroup(tasks: DownloadTask[], name: string) {
    return this.deleteMany(tasks, this.translate.instant('downloads.confirm_delete_group', { count: tasks.length, name }));
  }

  seasonName(show: string, seasonNumber: number | null): string {
    if (seasonNumber === null) return show;
    const season = this.translate.instant(
      seasonNumber === 0 ? 'media_detail.specials' : 'media_detail.season_number',
      { number: seasonNumber },
    );
    return `${show} · ${season}`;
  }

  toggleSelectMode() {
    this.selectMode.update((v) => !v);
    this.selectedIds.set(new Set());
  }

  toggleSelected(id: number) {
    this.selectedIds.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  selectAll() {
    this.selectedIds.set(new Set(this.items().map((t) => t.id)));
  }

  deleteSelected() {
    const tasks = this.selectedTasks();
    return this.deleteMany(
      tasks,
      this.translate.instant('downloads.confirm_delete_many', { count: tasks.length }),
    );
  }

  async retrySelected() {
    for (const task of this.selectedFailed()) await this.retryItem(task);
    this.selectedIds.set(new Set());
  }

  async retryItem(task: DownloadTask) {
    if (this.retrying().has(task.id)) return;
    this.retrying.update((s) => new Set(s).add(task.id));
    try {
      await this.dlManager.retryDownload(task);
    } catch {
      this.toast.error(this.translate.instant('downloads.failed'));
    } finally {
      this.retrying.update((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
    }
  }

  playOffline(task: DownloadTask) {
    void this.router.navigate(['/watch', task.mediaFileId], {
      queryParams: {
        mediaId: task.mediaId,
        ...(task.episodeId ? { episodeId: task.episodeId } : {}),
        offline: '1',
      },
    });
  }
}
