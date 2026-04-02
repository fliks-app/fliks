import { Injectable, signal, inject, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from './toast.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';

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

  readonly activeProgress = signal<Map<string, TaskProgress>>(new Map());
  readonly lastEvent = signal<SseEvent | null>(null);
  private eventSource: EventSource | null = null;

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
        this.lastEvent.set(data);
        this.handleEvent(data);
      } catch { /* ignore parse errors */ }
    };
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      setTimeout(() => this.connect(), 5000);
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
        this.toast.success(this.translate.instant('sse.subtitle_synced'));
        break;
      case 'subtitle.downloaded':
        this.toast.success(
          this.translate.instant('sse.subtitle_downloaded', {
            title: event['title'] ?? '',
            lang: event['language'] ?? '',
          }),
        );
        break;
      case 'import.complete':
        this.toast.success(
          this.translate.instant('sse.import_complete', { title: event['title'] ?? '' }),
        );
        break;
      case 'stalled.removed':
        this.toast.info(
          this.translate.instant('sse.stalled_removed', { title: event['title'] ?? '' }),
        );
        break;
    }
  }

  ngOnDestroy() {
    this.eventSource?.close();
  }
}
