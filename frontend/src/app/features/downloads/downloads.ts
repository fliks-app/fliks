import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  effect,
  inject,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  DownloadsApiService,
  DownloadTask,
} from '../../core/services/api/downloads-api.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { SseService } from '../../core/services/sse.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { TranslateService } from '@ngx-translate/core';
import { LucideDownload, LucideTrash2, LucidePlay, LucideAlertCircle } from '@lucide/angular';

export interface DisplayDownloadTask extends DownloadTask {
  downloadProgress?: number;
}

@Component({
  selector: 'app-downloads',
  imports: [TranslateModule, LucideDownload, LucideTrash2, LucidePlay, LucideAlertCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './downloads.html',
})
export class DownloadsComponent implements OnInit {
  private readonly downloadsApi = inject(DownloadsApiService);
  private readonly offlineStorage = inject(OfflineStorageService);
  readonly downloadCache = inject(DownloadCacheService);
  private readonly sse = inject(SseService);
  private readonly router = inject(Router);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);

  private readonly baseTasks = signal<DownloadTask[]>([]);
  readonly loading = signal(true);

  /** React to SSE download events — UI refresh only (device download handled by DownloadManagerService) */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;
    if (event.type === 'download.progress') {
      const downloadId = event['downloadId'] as number;
      const progress = event['progress'] as number;
      this.baseTasks.update((tasks) => {
        // Update if exists, otherwise add as new task
        if (tasks.some((t) => t.id === downloadId)) {
          return tasks.map((t) =>
            t.id === downloadId ? { ...t, progress, status: 'transcoding' } : t,
          );
        }
        // Task not in list yet — reload to pick it up
        void this.load();
        return tasks;
      });
    } else if (event.type === 'download.ready') {
      const downloadId = event['downloadId'] as number;
      this.baseTasks.update((tasks) =>
        tasks.map((t) =>
          t.id === downloadId ? { ...t, status: 'ready', progress: 100 } : t,
        ),
      );
      // If task wasn't in the list, reload
      if (!this.baseTasks().some((t) => t.id === downloadId)) {
        void this.load();
      }
    } else if (event.type === 'download.failed') {
      const downloadId = event['downloadId'] as number;
      this.baseTasks.update((tasks) =>
        tasks.map((t) =>
          t.id === downloadId ? { ...t, status: 'failed' } : t,
        ),
      );
    }
  });

  readonly items = computed<DisplayDownloadTask[]>(() => {
    const tasks = this.baseTasks();
    const active = this.downloadCache.activeDownloads();
    return tasks.map((task) => {
      if (task.status === 'ready' && active.has(task.id)) {
        return { ...task, status: 'downloading', downloadProgress: active.get(task.id) ?? 0 };
      }
      return task;
    });
  });

  ngOnInit() {
    this.load();
  }

  async load() {
    // Show cached data instantly (no loading spinner for cached content)
    const cached = this.downloadCache.load();
    if (cached.length) {
      await this.applyFilter(cached);
      this.loading.set(false);
    }

    // Then try API in background for fresh data
    try {
      const list = await this.downloadsApi.list();
      this.downloadCache.save(list);
      await this.applyFilter(list);
    } catch {
      // Offline — cached data already displayed
    } finally {
      this.loading.set(false);
    }
  }

  private async applyFilter(list: DownloadTask[]) {
    const filtered: DownloadTask[] = [];
    for (const task of list) {
      if (
        task.status === 'transcoding' ||
        task.status === 'remuxing' ||
        task.status === 'pending'
      ) {
        filtered.push(task);
      } else if (task.status === 'ready') {
        if (this.downloadCache.isDownloading(task.id)) {
          filtered.push(task);
        } else {
          const hasLocal = await this.offlineStorage.has(
            `download-${task.mediaFileId}`,
          );
          if (hasLocal) filtered.push(task);
        }
      }
    }
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
    await this.offlineStorage.delete(`download-${task.mediaFileId}`);
    await this.downloadsApi.delete(task.id).catch(() => {});
    this.downloadCache.remove(task.id);
    this.baseTasks.update((list) => list.filter((t) => t.id !== task.id));
  }

  playOffline(task: DownloadTask) {
    void this.router.navigate(['/watch', task.mediaFileId], {
      queryParams: {
        mediaId: task.mediaId,
        ...(task.episodeId ? { episodeId: task.episodeId } : {}),
      },
    });
  }

  statusLabel(status: string): string {
    switch (status) {
      case 'transcoding':
      case 'remuxing':
        return 'downloads.transcoding';
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

  formatSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  }
}
