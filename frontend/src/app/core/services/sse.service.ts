import { Injectable, signal, OnDestroy } from '@angular/core';

export interface TaskProgress {
  command: string;
  current: number;
  total: number;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class SseService implements OnDestroy {
  readonly activeProgress = signal<Map<string, TaskProgress>>(new Map());
  private eventSource: EventSource | null = null;

  connect() {
    if (this.eventSource) return;
    this.eventSource = new EventSource('/api/system/events');
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TaskProgress;
        this.activeProgress.update(m => {
          const next = new Map(m);
          if (data.current >= data.total) {
            next.delete(data.command);
          } else {
            next.set(data.command, data);
          }
          return next;
        });
      } catch { /* ignore parse errors */ }
    };
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      // Reconnect after 5s
      setTimeout(() => this.connect(), 5000);
    };
  }

  ngOnDestroy() {
    this.eventSource?.close();
  }
}
