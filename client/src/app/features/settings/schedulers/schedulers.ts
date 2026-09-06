import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LucideCirclePlay } from '@lucide/angular';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { ToastService } from '../../../core/services/toast.service';
import { SseService } from '../../../core/services/sse.service';

interface SchedulerInfo {
  name: string;
  /** Supplied by the API: core's own key for a core job, the declaring plugin's for one it
   *  owns. The page never names a job itself — it would have to know every publisher. */
  labelKey: string;
  cron: string;
  triggerable: boolean;
  lastRun: string | null;
  lastStatus: string | null;
  nextRun: string;
}

@Component({
  selector: 'app-schedulers',
  imports: [LucideCirclePlay, TranslatePipe, LocaleDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schedulers.html',
})
export class SchedulersComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly sse = inject(SseService);

  readonly loading = signal(true);
  readonly schedulers = signal<SchedulerInfo[]>([]);
  readonly triggerBusy = signal<string | null>(null);

  constructor() {
    effect(() => {
      const event = this.sse.lastEvent();
      if (
        event?.type === 'command.started' ||
        event?.type === 'command.completed'
      ) {
        this.refreshList();
      }
    });
  }

  async ngOnInit() {
    await this.refreshList();
    this.loading.set(false);
  }

  statusBadgeClass(status: string | null): string {
    switch (status) {
      case 'completed':
        return 'badge-success';
      case 'running':
        return 'badge-info';
      case 'failed':
        return 'badge-error';
      case 'queued':
        return 'badge-warning';
      default:
        return 'badge-ghost';
    }
  }

  async trigger(name: string) {
    this.triggerBusy.set(name);
    try {
      await firstValueFrom(
        this.http.post('/api/commands', { name }),
      );
      this.toast.success(
        this.translate.instant('settings.schedulers.triggered', { name }),
      );
    } catch {
      // handled by global interceptor
    } finally {
      this.triggerBusy.set(null);
    }
  }

  private async refreshList() {
    try {
      const data = await firstValueFrom(
        this.http.get<SchedulerInfo[]>('/api/commands/schedulers'),
      );
      this.schedulers.set(data);
    } catch {
      // handled by global interceptor
    }
  }
}
