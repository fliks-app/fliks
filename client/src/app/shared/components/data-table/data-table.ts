import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { RowAction, TableColumn, TableRow } from './data-table.types';

/**
 * The `table` view kind from the plugin plan: declared columns, declared row
 * actions, no client-side sorting beyond one declared default, no pluggable
 * cell renderers. Deliberately not a general grid.
 */
@Component({
  selector: 'app-data-table',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-table.html',
})
export class DataTableComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly titleKey = input.required<string>();
  readonly listUrl = input.required<string>();
  readonly columns = input.required<readonly TableColumn[]>();
  readonly rowActions = input<readonly RowAction[]>([]);
  /** Applied once after load; there is no header-click re-sort. */
  readonly defaultSortKey = input<string | null>(null);
  readonly loadErrorKey = input('data_table.load_error');
  readonly emptyKey = input('data_table.empty');
  /** Resolves a core `actionId`; undefined = unknown = the button must not render (fail closed). */
  readonly resolveAction = input<(actionId: string, row: TableRow) => (() => void) | undefined>(() => undefined);

  readonly rows = signal<TableRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly busy = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadRows();
  }

  async loadRows(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      const data = await firstValueFrom(this.http.get<TableRow[]>(this.listUrl()));
      this.rows.set(this.applyDefaultSort(Array.isArray(data) ? data : []));
    } catch {
      this.listError.set(this.translate.instant(this.loadErrorKey()));
    } finally {
      this.loading.set(false);
    }
  }

  private applyDefaultSort(rows: TableRow[]): TableRow[] {
    const key = this.defaultSortKey();
    if (!key) return rows;
    return [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null) return bv == null ? 0 : -1;
      if (bv == null) return 1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
  }

  /** Drops any `action`-kind entry whose actionId the host doesn't recognise. */
  visibleActions(row: TableRow): { action: RowAction; run: () => void | Promise<void> }[] {
    const result: { action: RowAction; run: () => void | Promise<void> }[] = [];
    for (const action of this.rowActions()) {
      if (action.kind === 'action') {
        const handler = this.resolveAction()(action.actionId, row);
        if (handler) result.push({ action, run: handler });
      } else if (action.kind === 'route') {
        result.push({ action, run: () => { void this.router.navigateByUrl(action.path); } });
      } else {
        result.push({ action, run: () => this.runProxy(row, action) });
      }
    }
    return result;
  }

  private async runProxy(
    row: TableRow,
    action: { kind: 'proxy'; method: 'POST' | 'DELETE'; path: string; confirmKey?: string },
  ): Promise<void> {
    if (action.confirmKey) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant(action.confirmKey),
        variant: 'danger',
      });
      if (!ok) return;
    }
    const busyKey = `${row.id}:${action.path}`;
    this.busy.set(busyKey);
    try {
      await firstValueFrom(action.method === 'POST' ? this.http.post(action.path, {}) : this.http.delete(action.path));
      await this.loadRows();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.busy.set(null);
    }
  }
}
