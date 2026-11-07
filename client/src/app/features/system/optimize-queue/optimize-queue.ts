import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  LEVELS,
  type JobState,
  type OptimizeJob,
  type OptimizeWorker,
  type QueueStatus,
  savedBytes,
} from '../../../core/models/optimize';
import { formatBytes } from '../../../core/utils/format-bytes';
import { formatEta } from '../../../shared/utils/download-format';

export type QueueTab = 'active' | 'failures' | 'finished';

/** Job states each tab lists; the API filters one state per call. */
const TAB_STATES: Record<QueueTab, JobState[]> = {
  active: ['leased', 'staged', 'committing', 'queued'],
  failures: ['failed', 'skipped'],
  finished: ['done'],
};
const RUNNING: JobState[] = ['leased', 'staged', 'committing'];
const RELOAD_DEBOUNCE_MS = 400;

export interface DeviceRow {
  worker: string;
  id: string;
  maxJobs: number;
  jobs: OptimizeJob[];
  /** Every job of the device is held back by playback. */
  paused: boolean;
}

@Component({
  selector: 'app-optimize-queue',
  imports: [DatePipe, RouterLink, TranslatePipe],
  templateUrl: './optimize-queue.html',
})
export class OptimizeQueueComponent implements OnInit {
  private readonly api = inject(OptimizeService);
  private readonly libraries = inject(LibrariesApiService);
  private readonly sse = inject(SseService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs: QueueTab[] = ['active', 'failures', 'finished'];
  readonly levels = LEVELS;
  readonly formatBytes = formatBytes;
  readonly savedBytes = savedBytes;
  readonly eta = (s: number | null) => (s == null ? '-' : formatEta(Math.round(s)));

  readonly tab = signal<QueueTab>('active');
  readonly libraryId = signal<number | null>(null);
  readonly libraryList = signal<Library[]>([]);
  readonly status = signal<QueueStatus | null>(null);
  readonly workers = signal<OptimizeWorker[]>([]);
  readonly jobs = signal<OptimizeJob[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  /** Waiting jobs ticked for a batch action, in the order they were ticked. */
  readonly selected = signal<number[]>([]);

  readonly running = computed(() => this.jobs().filter((j) => RUNNING.includes(j.state)));
  readonly waiting = computed(() => this.jobs().filter((j) => j.state === 'queued'));
  readonly counts = computed(() => this.status()?.counts ?? {});
  readonly runningCount = computed(() => RUNNING.reduce((n, s) => n + (this.counts()[s] ?? 0), 0));
  readonly state = computed<'paused' | 'closed' | 'running'>(() => {
    const s = this.status();
    return s?.paused ? 'paused' : s && !s.open ? 'closed' : 'running';
  });

  readonly devices = computed<DeviceRow[]>(() =>
    this.workers().flatMap((w) =>
      w.devices.map((d) => {
        const jobs = this.running().filter((j) => j.workerId === w.instance && j.deviceId === d.id);
        return {
          worker: w.instance,
          id: d.id,
          maxJobs: d.maxJobs,
          jobs,
          paused: jobs.length > 0 && jobs.every((j) => j.paused),
        };
      }),
    ),
  );

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per fetch: a late answer of a previous tab or filter is dropped. */
  private seq = 0;

  constructor() {
    effect(() => {
      this.tab();
      this.libraryId();
      untracked(() => {
        this.selected.set([]);
        void this.loadJobs();
      });
    });
    this.sse.optimizeEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e.type === 'optimize.job_progress') {
        const id = Number(e['jobId']);
        this.jobs.update((l) =>
          l.map((j) =>
            j.id === id
              ? { ...j, progress: Number(e['progress']), paused: e['paused'] === true }
              : j,
          ),
        );
      } else {
        this.scheduleReload();
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
    });
  }

  ngOnInit() {
    void this.libraries
      .list()
      .then((l) => this.libraryList.set(l))
      .catch(() => undefined);
    void this.loadStatus();
  }

  private scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.loadStatus();
      void this.loadJobs();
    }, RELOAD_DEBOUNCE_MS);
  }

  private async loadStatus() {
    try {
      const [status, workers] = await Promise.all([this.api.queueStatus(), this.api.workers()]);
      this.status.set(status);
      this.workers.set(workers);
    } catch {
      // The global interceptor toasts the reason.
    }
  }

  private async loadJobs() {
    const seq = ++this.seq;
    const libraryId = this.libraryId();
    try {
      const lists = await Promise.all(
        TAB_STATES[this.tab()].map((state) => this.api.jobs({ state, libraryId, limit: 200 })),
      );
      if (seq !== this.seq) return;
      this.jobs.set(lists.flat());
      this.selected.update((ids) => ids.filter((id) => lists.flat().some((j) => j.id === id)));
    } catch {
      // Keeps the last list; the interceptor toasts.
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  setLibrary(v: string) {
    this.libraryId.set(v === '' ? null : Number(v));
  }

  async togglePause() {
    this.busy.set(true);
    try {
      await (this.status()?.paused ? this.api.resume() : this.api.pause());
      await this.loadStatus();
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.busy.set(false);
    }
  }

  toggle(id: number) {
    this.selected.update((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
  }

  toggleAll() {
    this.selected.set(
      this.selected().length === this.waiting().length ? [] : this.waiting().map((j) => j.id),
    );
  }

  /** Runs a queue action, then refreshes; a refused one is toasted by the interceptor. */
  private async act(fn: () => Promise<unknown>, done?: string) {
    this.busy.set(true);
    try {
      await fn();
      if (done) this.toast.success(this.translate.instant(done));
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.busy.set(false);
      await Promise.all([this.loadStatus(), this.loadJobs()]);
    }
  }

  moveToFront() {
    const ids = this.waiting()
      .map((j) => j.id)
      .filter((id) => this.selected().includes(id));
    return this.act(async () => {
      await this.api.prioritize(ids);
      this.selected.set([]);
    });
  }

  async cancelSelected() {
    const ids = this.selected();
    if (!(await this.confirmCancel(ids.length))) return;
    await this.act(async () => {
      await this.api.cancelMany(ids);
      this.selected.set([]);
    });
  }

  async cancelOne(j: OptimizeJob) {
    if (!(await this.confirmCancel(1))) return;
    await this.act(() => this.api.cancel(j.id));
  }

  private confirmCancel(count: number) {
    return this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('optimize.queue.confirm_cancel', { count }),
      variant: 'danger',
    });
  }

  retry(j: OptimizeJob) {
    return this.act(() => this.api.retry(j.id), 'optimize.queue.retried');
  }

  async restore(j: OptimizeJob) {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('optimize.queue.confirm_restore', { title: j.title ?? '' }),
      variant: 'danger',
    });
    if (ok) await this.act(() => this.api.restore(j.id), 'optimize.queue.restored');
  }

  stateKey(j: OptimizeJob) {
    return j.state === 'leased' ? (j.paused ? 'paused' : 'encoding') : j.state;
  }
}
