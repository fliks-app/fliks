import { Injectable, signal, inject, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from './toast.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { DownloadProgressService } from './download-progress.service';
import { MediaType } from '../enums/media-type.enum';
import { invalidatePrefix } from '../interceptors/cache.interceptor';

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

export interface TaskProgress {
  type: 'task.progress';
  command: string;
  current: number;
  total: number;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class SseService implements OnDestroy {
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly downloadProgress = inject(DownloadProgressService);

  readonly activeProgress = signal<Map<string, TaskProgress>>(new Map());
  readonly lastEvent = signal<SseEvent | null>(null);
  /** Issued by the backend on SSE connect — bound to live sessions so admin
   *  remote-control reaches only this device/tab. */
  readonly connectionId = signal<string | null>(null);
  private eventSource: EventSource | null = null;
  private retryDelay = 5000;

  /** Force reconnect (e.g. after app resume from background) */
  reconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.retryDelay = 5000;
    this.connect();
  }

  connect() {
    if (this.eventSource) return;

    let url = '/api/system/events';

    if (this.serverConfig.isNative) {
      url = this.serverConfig.resolveUrl(url);
      const token = this.auth.accessToken;
      if (token) {
        url += `?token=${encodeURIComponent(token)}`;
      }
    }

    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SseEvent;
        if (data.type === 'sse.connected') {
          const id = data['connectionId'];
          if (typeof id === 'string' && id) {
            this.connectionId.set(id);
          }
          return;
        }
        this.handleEvent(data);
        // Don't update lastEvent for high-frequency progress events
        // (handled via dedicated signals/stores instead)
        if (data.type !== 'task.progress' && data.type !== 'download.progress') {
          this.lastEvent.set(data);
        }
      } catch { /* ignore parse errors */ }
    };
    this.retryDelay = 5000; // Reset on successful connection
    this.eventSource.onopen = () => { this.retryDelay = 5000; };
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.connectionId.set(null);
      if (!navigator.onLine) {
        // Offline — wait for online event instead of polling
        window.addEventListener('online', () => this.connect(), { once: true });
        return;
      }
      // Exponential backoff: 5s → 10s → 20s → 30s max
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    };
  }

  private handleEvent(event: SseEvent) {
    switch (event.type) {
      case 'task.progress': {
        const tp = event as unknown as TaskProgress;
        this.activeProgress.update((m) => {
          const next = new Map(m);
          if (tp.current >= tp.total) {
            next.delete(tp.command);
          } else {
            next.set(tp.command, tp);
          }
          return next;
        });
        break;
      }
      case 'subtitle.synced':
      case 'subtitle.downloaded':
      case 'subtitle.failed':
        // These land asynchronously (e.g. an OCR or sync finishing minutes after
        // the request returned), so no client mutation invalidated the cached
        // subtitle list — drop the media cache here so the next fetch is fresh.
        void invalidatePrefix('/api/media');
        // Toasts are handled by the media-detail component (only on the right page).
        break;
      case 'download.progress':
        this.downloadProgress.applyProgress({
          mediaId: Number(event['mediaId']),
          mediaType: event['mediaType'] as MediaType,
          seasonNumber: event['seasonNumber'] as number | undefined,
          episodeNumber: event['episodeNumber'] as number | undefined,
          hash: event['hash'] as string | undefined,
          progress: Number(event['progress']),
          dlspeed: Number(event['dlspeed'] ?? 0),
          eta: Number(event['eta'] ?? 0),
          state: String(event['state'] ?? ''),
        });
        break;
      case 'import.complete':
        // The download finished → retire its live progress (just the imported
        // season for a series; the whole entry otherwise).
        this.downloadProgress.clearMedia(
          Number(event['mediaId']),
          event['seasonNumber'] as number | undefined,
          event['episodeNumber'] as number | undefined,
        );
        this.toast.success(
          this.translate.instant('sse.import_complete', { title: event['title'] ?? '' }),
        );
        break;
      case 'stalled.removed':
        this.toast.info(
          this.translate.instant('sse.stalled_removed', { title: event['title'] ?? '' }),
        );
        break;
      case 'rescan.started':
        // Toast shown from media-detail / episode-detail when POST /rescan returns
        break;
      case 'rescan.completed': {
        const base = this.translate.instant('sse.rescan_completed', {
          title: event['title'] ?? '',
          added: event['added'] ?? 0,
          removed: event['removed'] ?? 0,
          updated: event['updated'] ?? 0,
        });
        const sm = Number(event['subtitleRemovedMissing'] ?? 0);
        const sd = Number(event['subtitleRemovedDuplicates'] ?? 0);
        let msg = base;
        if (sm || sd) {
          msg +=
            ' — ' +
            this.translate.instant('sse.rescan_subtitles_cleaned', {
              missing: sm,
              duplicates: sd,
            });
        }
        this.toast.success(msg);
        break;
      }
      case 'rescan.failed':
        this.toast.error(
          this.translate.instant('sse.rescan_failed', { title: event['title'] ?? '' }),
        );
        break;
    }
  }

  ngOnDestroy() {
    this.eventSource?.close();
  }
}
