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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  DownloadsApiService,
  DownloadTask,
} from '../../core/services/api/downloads-api.service';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import {
  DownloadNotificationService,
} from '../../core/services/download-notification.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { LucideDownload, LucideTrash2, LucidePlay, LucideAlertCircle, LucideRotateCcw } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

export interface DisplayDownloadTask extends DownloadTask {
  downloadProgress?: number;
}

/**
 * Downloads page.
 *
 * Data sources:
 *   - Server API: task metadata (title, quality, file size, poster)
 *   - Java service (native): real-time progress/status (single source of truth on Android)
 *   - SSE events (web): real-time progress
 *   - DownloadCacheService (web): device download progress
 *
 * On native, every load() syncs progress from Java service.
 * Native events are only used between load() calls for responsiveness.
 */
@Component({
  selector: 'app-downloads',
  imports: [TranslateModule, ResolveUrlPipe, LucideDownload, LucideTrash2, LucidePlay, LucideAlertCircle, LucideRotateCcw],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './downloads.html',
})
export class DownloadsComponent implements OnInit, OnDestroy {
  private readonly isNative = Capacitor.isNativePlatform();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler = () => {
    if (document.visibilityState === 'visible') void this.load();
  };
  private readonly api = inject(DownloadsApiService);
  private readonly cache = inject(DownloadCacheService);
  private readonly dlManager = inject(DownloadManagerService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);

  private readonly baseTasks = signal<DownloadTask[]>([]);
  readonly loading = signal(true);


  /**
   * Java service state — synced on every load().
   * Key = taskId, Value = { progress, status } from Java's activeTasks.
   */
  private readonly nativeState = signal<Map<number, { progress: number; status: string }>>(new Map());

  /** Web only: react to download manager events */
  private readonly sseEffect = !this.isNative ? effect(() => {
    const event = this.dlManager.lastDownloadEvent();
    if (!event) return;
    if (event.type === 'progress') {
      // Normalize status to DB values (template only matches transcoding/pending)
      const status = event.status === 'downloading' ? 'transcoding'
        : (event.status ?? 'transcoding');
      this.nativeState.update((m) => {
        const next = new Map(m);
        next.set(event.taskId, { progress: event.progress, status });
        return next;
      });
    } else {
      void this.load();
    }
  }) : null;

  /** Native: react to complete/failed events for immediate UI update */
  private readonly nativeEventEffect = this.isNative ? effect(() => {
    const event = this.dlManager.lastDownloadEvent();
    if (!event) return;
    if (event.type === 'complete') {
      this.cache.markLocal(event.taskId);
    }
  }) : null;

  /** Derived: merge server tasks with native state (native always wins) */
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
      // Server "ready" = transcode done. Only show "ready" if file is on device.
      if (task.status === 'ready') {
        if (localIds.has(task.id)) {
          return task; // File on device — show "ready" (playable)
        }
        // File not on device — show as in-progress (progressive DL still running)
        const pct = active.get(task.id) ?? 0;
        return { ...task, status: 'transcoding', progress: pct } as DisplayDownloadTask;
      }
      return task;
    });
  });

  ngOnInit() {
    this.load();
    document.addEventListener('visibilitychange', this.visibilityHandler);
    // Native: poll Java service every 2s for real-time progress (reliable, no event loss)
    if (this.isNative) {
      this.syncTimer = setInterval(() => void this.syncFromNativeService(), 2000);
    }
  }

  ngOnDestroy() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  async load() {
    // On native: sync from Java service first (single source of truth for progress)
    if (this.isNative) {
      await this.syncFromNativeService();
    }

    const cached = this.cache.load();
    if (cached.length) {
      this.applyFilter(cached);
      this.loading.set(false);
    }
    try {
      const list = await this.api.list();
      this.cache.save(list);
      this.applyFilter(list);
    } catch {
      // Offline — cached data already shown
    } finally {
      this.loading.set(false);
    }
  }

  /** Pull current progress/status from native DownloadManager into nativeState */
  private async syncFromNativeService() {
    const downloads = await this.notif.getDownloads();
    const next = new Map<number, { progress: number; status: string }>();
    for (const dl of downloads) {
      const tid = Number(dl.id) || 0;
      // Normalize native states to DB-compatible statuses
      const status = dl.state === 'failed' ? 'failed'
        : dl.state === 'completed' ? 'ready'
        : 'transcoding'; // downloading/queued/stopped all show as "in progress"
      next.set(tid, { progress: dl.progress, status });
    }

    const prev = this.nativeState();
    let needsReload = false;
    for (const tid of prev.keys()) {
      if (!next.has(tid)) needsReload = true;
    }

    this.nativeState.set(next);
    if (needsReload) void this.load();
  }

  private applyFilter(list: DownloadTask[]) {
    const filtered = list.filter((t) =>
      ['transcoding', 'pending', 'failed', 'ready'].includes(t.status),
    );
    this.baseTasks.set(filtered);
  }

  async retryItem(task: DownloadTask) {
    try {
      const updated = await this.dlManager.retryDownload(task.id);
      this.baseTasks.update((list) =>
        list.map((t) => (t.id === task.id ? updated : t)),
      );
    } catch {
      // ignore
    }
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
      case 'ready':
        return 'downloads.ready';
      case 'failed':
        return 'downloads.failed';
      default:
        return '';
    }
  }

}
