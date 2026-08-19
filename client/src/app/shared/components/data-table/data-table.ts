import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { formatBytes } from '../../utils/download-format';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { PaginationComponent } from '../pagination/pagination';
import { BadgeTone, CellValue, ListAction, PagedResult, RowAction, TableColumn, TableFilter, TableRow } from './data-table.types';

/** Keystroke-to-request debounce for a `search` filter — see `onSearchInput`. */
const SEARCH_DEBOUNCE_MS = 300;

/** The only classes a declared badge can resolve to. A `badges` entry is JSON from a
 *  manifest, so it is looked up here and never interpolated into the rendered `class`. */
const BADGE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'badge-neutral',
  primary: 'badge-primary',
  secondary: 'badge-secondary',
  accent: 'badge-accent',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  ghost: 'badge-ghost',
};

/**
 * The `table` view kind: declared columns, declared row actions, no
 * client-side sorting beyond one declared default, no pluggable cell
 * renderers. Deliberately not a general grid.
 */
@Component({
  selector: 'app-data-table',
  imports: [TranslateModule, LocaleDatePipe, PaginationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-table.html',
})
export class DataTableComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  /** Empty renders no heading — an embedded table (a row action's result) carries its own. */
  readonly titleKey = input('');
  readonly listUrl = input.required<string>();
  readonly columns = input.required<readonly TableColumn[]>();
  readonly rowActions = input<readonly RowAction[]>([]);
  /** List-scope actions (`ListAction[]`) — rendered once, next to the title. */
  readonly listActions = input<readonly ListAction[]>([]);
  /** Applied once after load; there is no header-click re-sort. */
  readonly defaultSortKey = input<string | null>(null);
  readonly loadErrorKey = input('data_table.load_error');
  readonly emptyKey = input('data_table.empty');
  /** Resolves a core `actionId`; undefined = unknown = the button must not render (fail closed). */
  readonly resolveAction = input<(actionId: string, row: TableRow) => (() => void) | undefined>(() => undefined);
  /** `list` answers `{data,total,page,pageSize}` rather than a bare array. */
  readonly paged = input(false);
  readonly pageSize = input(20);
  /** Declared `search`/`select` filters, rendered above the table. */
  readonly filters = input<readonly TableFilter[]>([]);

  readonly rows = signal<TableRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly busy = signal<string | null>(null);
  readonly listActionBusy = signal<string | null>(null);

  readonly page = signal(1);
  readonly total = signal(0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  /** Current value per filter `key`; an empty entry is omitted from the request. */
  readonly filterValues = signal<Record<string, string>>({});
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.searchDebounce) clearTimeout(this.searchDebounce);
    });
  }

  ngOnInit(): void {
    void this.loadRows();
  }

  async loadRows(): Promise<void> {
    // Only the newest reload may write: a filtered scan can resolve after a later, narrower one.
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.listError.set('');
    try {
      let params = new HttpParams();
      for (const [key, value] of Object.entries(this.filterValues())) {
        if (value) params = params.set(key, value);
      }
      if (this.paged()) {
        params = params.set('page', this.page()).set('pageSize', this.pageSize());
        const res = await firstValueFrom(this.http.get<PagedResult<TableRow>>(this.listUrl(), { params }));
        if (seq !== this.loadSeq) return;
        this.rows.set(this.applyDefaultSort(Array.isArray(res?.data) ? res.data : []));
        this.total.set(res?.total ?? 0);
      } else {
        const data = await firstValueFrom(this.http.get<TableRow[]>(this.listUrl(), { params }));
        if (seq !== this.loadSeq) return;
        this.rows.set(this.applyDefaultSort(Array.isArray(data) ? data : []));
      }
    } catch {
      if (seq === this.loadSeq) this.listError.set(this.translate.instant(this.loadErrorKey()));
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /** A `select` filter reloads immediately; a `search` box debounces so a fast typist
   *  doesn't fire one query per keystroke against the plugin's own (uncached) database. */
  onSearchInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filterValues.update((v) => ({ ...v, [key]: value }));
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => void this.applyFilterChange(), SEARCH_DEBOUNCE_MS);
  }

  onSelectChange(key: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.filterValues.update((v) => ({ ...v, [key]: value }));
    void this.applyFilterChange();
  }

  /** A key with no entry yet — no keystroke, no default selection — reads as ''. */
  filterValue(key: string): string {
    return (this.filterValues() as Record<string, string | undefined>)[key] ?? '';
  }

  private async applyFilterChange(): Promise<void> {
    // Disarms a still-pending debounce so an immediate caller (e.g. a select) can't double-fire it.
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.page.set(1);
    await this.loadRows();
  }

  async goToPage(page: number): Promise<void> {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    await this.loadRows();
  }

  /** `LocaleDatePipe` doesn't accept a boolean — no declared column is ever meant to be one. */
  cellDate(value: CellValue): string | number | null {
    return typeof value === 'boolean' ? null : value ?? null;
  }

  cellBytes(value: CellValue): string {
    return typeof value === 'number' ? formatBytes(value) : String(value ?? '');
  }

  cellPercent(value: CellValue): string {
    return typeof value === 'number' ? `${Math.round(value)}%` : String(value ?? '');
  }

  /**
   * The badge class for a cell, or null to render it as text. `*` catches every value the
   * column didn't name; an unknown tone falls back to `ghost` rather than reaching the DOM.
   */
  badgeClass(col: TableColumn, value: CellValue): string | null {
    const tones = col.badges;
    if (!tones) return null;
    const tone = tones[String(value ?? '')] ?? tones['*'];
    if (!tone) return null;
    return BADGE_CLASSES[tone] ?? BADGE_CLASSES.ghost;
  }

  /** A formatted value, a badge and a declared `nowrap` are all atomic — none should wrap. */
  cellNowrap(col: TableColumn): boolean {
    return col.nowrap === true || col.format !== undefined || col.badges !== undefined;
  }

  /** An undeclared value renders as itself rather than as a missing translate key. */
  cellLabel(col: TableColumn, value: CellValue): string {
    const raw = String(value ?? '');
    const key = col.labelKeys?.[raw];
    return key ? this.translate.instant(key) : raw;
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
    this.busy.set(`${row.id}:${action.path}`);
    try {
      if (await this.runHttpAction(action.method, action.path, action.confirmKey)) await this.loadRows();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.busy.set(null);
    }
  }

  /** Runs a `listActions[]` entry — same confirm+call contract as a row's `proxy` action, unscoped to a row. */
  async runListAction(action: ListAction): Promise<void> {
    this.listActionBusy.set(action.path);
    try {
      if (await this.runHttpAction(action.method, action.path, action.confirmKey)) await this.loadRows();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.listActionBusy.set(null);
    }
  }

  /** Returns false without calling anything when the user declines the confirm — not an error. */
  private async runHttpAction(method: 'POST' | 'DELETE', path: string, confirmKey?: string): Promise<boolean> {
    if (confirmKey) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant(confirmKey),
        variant: 'danger',
      });
      if (!ok) return false;
    }
    await firstValueFrom(method === 'POST' ? this.http.post(path, {}) : this.http.delete(path));
    return true;
  }
}
