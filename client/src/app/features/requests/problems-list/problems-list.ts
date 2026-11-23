import { Component, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { ProblemRow, ProblemStatusFilter, ProblemsService } from '../../../core/services/api/problems.service';
import { SseService, requestActivity } from '../../../core/services/sse.service';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { RowSkeletonComponent } from '../../../shared/components/row-skeleton/row-skeleton';
import { ProblemCardComponent, ProblemResolveMode } from '../problem-card/problem-card';
import { ProblemResolveDialogComponent } from '../problem-resolve-dialog/problem-resolve-dialog';

const PAGE_SIZE = 25;
const SSE_DEBOUNCE_MS = 300;

/** The Problems view of the Requests page; the status filter lives in the URL and arrives as an input. */
@Component({
  selector: 'app-problems-list',
  imports: [EmptyStateComponent, RowSkeletonComponent, ProblemCardComponent, ProblemResolveDialogComponent, TranslatePipe],
  templateUrl: './problems-list.html',
})
export class ProblemsListComponent {
  private readonly api = inject(ProblemsService);
  private readonly sse = inject(SseService);

  readonly status = input<ProblemStatusFilter | ''>('');

  protected readonly rows = signal<ProblemRow[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly resolving = signal<{ id: number; mode: ProblemResolveMode } | null>(null);
  private readonly dialog = viewChild(ProblemResolveDialogComponent);

  constructor() {
    effect(() => {
      this.status();
      untracked(() => void this.fetch(1, false));
    });
    requestActivity(this.sse)
      .pipe(debounceTime(SSE_DEBOUNCE_MS), takeUntilDestroyed())
      .subscribe(() => void this.refresh());
  }

  protected loadMore() {
    void this.fetch(Math.floor(this.rows().length / PAGE_SIZE) + 1, true);
  }

  protected refresh() {
    return this.fetch(1, false, Math.max(PAGE_SIZE, this.rows().length));
  }

  protected openResolve(row: ProblemRow, mode: ProblemResolveMode) {
    this.resolving.set({ id: row.id, mode });
    this.dialog()?.showModal();
  }

  private async fetch(page: number, append: boolean, limit = PAGE_SIZE) {
    const status = this.status();
    if (!append && this.rows().length === 0) this.loading.set(true);
    try {
      const res = await this.api.list({ page, limit, ...(status ? { status } : {}) });
      this.rows.update((prev) => (append ? [...prev, ...res.data] : res.data));
      this.total.set(res.total);
    } catch {
      /* the global toast reports it */
    } finally {
      this.loading.set(false);
    }
  }
}
