import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  effect,
  inject,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Router } from '@angular/router';
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
} from '@lucide/angular';
import { ToastService } from '../../core/services/toast.service';
import { formatBytes } from '../../shared/utils/download-format';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

export interface DisplayDownloadTask extends DownloadTask {
  downloadProgress?: number;
}

/**
 * Downloads page.
 *
 * Data sources:
 *   - DownloadCacheService (localStorage): task metadata and status
 *   - Java service (native): real-time progress/status
 *   - DownloadManagerService events: real-time progress (web + native)
 */
@Component({
  selector: 'app-downloads',
  imports: [
    CachedSrcDirective,
    TranslatePipe,
    ResolveUrlPipe,
    LucideDownload,
    LucideTrash2,
    LucidePlay,
    LucideAlertCircle,
    LucideRotateCcw,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  protected readonly formatBytes = formatBytes;


  /**
   * Native/web state — synced on every load().
   * Key = taskId, Value = { progress, status }.
   */
  private readonly nativeState = signal<Map<number, { progress: number; status: string }>>(new Map());

  /** React to download manager events for real-time UI updates */
  private readonly eventEffect = effect(() => {
    const event = this.dlManager.lastDownloadEvent();
    if (!event) return;
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
      ['transcoding', 'pending', 'queued', 'downloading', 'failed', 'ready'].includes(
        t.status,
      ),
    );
    this.baseTasks.set(filtered);
  }

  async deleteItem(task: DownloadTask) {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('downloads.confirm_delete'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await this.dlManager.deleteDownload(task);
    this.cache.removeLocal(task.id);
    this.baseTasks.update((list) => list.filter((t) => t.id !== task.id));
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
