import {
  Component,
  signal,
  computed,
  inject,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DownloadCacheService, DownloadTask } from '../../core/services/download-cache.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
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
import { ToastService } from '../../core/services/toast.service';
import { formatBytes } from '../../shared/utils/download-format';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { SeasonLabelPipe } from '../../core/pipes/season-label.pipe';
import { AutoDownloadService } from '../../core/services/auto-download.service';
import { AutoDownloadRuleComponent } from '../../shared/components/auto-download-rule/auto-download-rule';
import { groupDownloads } from './downloads-grouping';

export interface DisplayDownloadTask extends DownloadTask {
  downloadProgress?: number;
}

/** Downloads page: DownloadCacheService (localStorage) for task metadata, the native Java service and DownloadManagerService events for live progress. */
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
  ],
  templateUrl: './downloads.html',
})
export class DownloadsComponent implements OnInit, OnDestroy {
  private readonly isNative = Capacitor.isNativePlatform();
  private visibilityHandler = () => {
    if (document.visibilityState === 'visible') void this.load();
  };
  private readonly cache = inject(DownloadCacheService);
  private readonly dlManager = inject(DownloadManagerService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /** Ids being re-queued, so the button can't be double-tapped into two
   *  downloads of the same file. */
  readonly retrying = signal<ReadonlySet<number>>(new Set());

  private readonly baseTasks = signal<DownloadTask[]>([]);
  readonly loading = signal(true);

  protected readonly emptySelection: ReadonlySet<number> = new Set();
  readonly selectMode = signal(false);
  readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  readonly selectedTasks = computed(() => this.items().filter((t) => this.selectedIds().has(t.id)));
  readonly selectedFailed = computed(() => this.selectedTasks().filter((t) => t.status === 'failed'));

  protected readonly formatBytes = formatBytes;


  /** Native/web state synced on every load(), keyed by taskId. */
  private readonly nativeState = signal<Map<number, { progress: number; status: string }>>(new Map());

  private readonly eventSub = this.dlManager.downloadEvents.pipe(takeUntilDestroyed()).subscribe((event) => {
    if (event.type === 'progress') {
      const status = event.status === 'downloading' ? 'transcoding'
        : (event.status ?? 'transcoding');
      this.nativeState.update((m) => {
        const next = new Map(m);
        next.set(event.taskId, { progress: event.progress, status });
        return next;
      });
    } else if (event.type === 'complete') {
      this.nativeState.update((m) => {
        const next = new Map(m);
        next.delete(event.taskId);
        return next;
      });
      this.cache.markLocal(event.taskId);
      void this.load();
    } else {
      void this.load();
    }
  });

  /** Derived: merge cached tasks with live state */
  readonly items = computed<DisplayDownloadTask[]>(() => {
    const tasks = this.baseTasks();
    const native = this.nativeState();
    const active = this.cache.activeDownloads();
    const localIds = this.cache.localTaskIds();

    return tasks.map((task) => {
      const ns = native.get(task.id);
      if (ns) {
        return { ...task, status: ns.status, progress: ns.progress } as DisplayDownloadTask;
      }
      if (task.status === 'ready') {
        if (localIds.has(task.id)) {
          return task;
        }
        const pct = active.get(task.id) ?? 0;
        return { ...task, status: 'transcoding', progress: pct } as DisplayDownloadTask;
      }
      return task;
    });
  });

  protected readonly auto = inject(AutoDownloadService);
  readonly entries = computed(() => groupDownloads(this.items()));
  readonly pausable = computed(() => this.items().filter((t) => DownloadsComponent.PAUSABLE.includes(t.status)));
  readonly paused = computed(() => this.items().filter((t) => t.status === 'paused'));
  private static readonly PAUSABLE = ['queued', 'transcoding', 'pending', 'downloading'];

  isPausable(task: DownloadTask): boolean {
    return DownloadsComponent.PAUSABLE.includes(task.status);
  }

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
    return [task.media?.type === 'series' ? '/series' : '/movies', String(task.mediaId)];
  }
  readonly totalBytes = computed(() => this.items().reduce((n, t) => n + (t.sizeBytes ?? 0), 0));

  ngOnInit() {
    this.load();
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  ngOnDestroy() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  async load() {
    const cached = this.cache.load();
    this.applyFilter(cached);
    this.loading.set(false);
  }



  private applyFilter(list: DownloadTask[]) {
    const filtered = list.filter((t) =>
      ['transcoding', 'pending', 'queued', 'downloading', 'paused', 'failed', 'ready'].includes(
        t.status,
      ),
    );
    this.baseTasks.set(filtered);
  }

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
        this.cache.removeLocal(task.id);
        this.baseTasks.update((list) => list.filter((t) => t.id !== task.id));
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
      await this.load();
    } catch {
      this.toast.error(this.translate.instant('downloads.failed'));
      await this.load();
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

  statusLabel(status: string): string {
    switch (status) {
      case 'transcoding':
      case 'pending':
        return 'downloads.downloading';
      case 'downloading':
        return 'downloads.downloading';
      case 'queued':
        return 'downloads.queued';
      case 'ready':
        return 'downloads.ready';
      case 'failed':
        return 'downloads.failed';
      default:
        return '';
    }
  }

}
