import { WritableSignal, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { vi } from 'vitest';
import { DataTableComponent } from './data-table';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { ListAction, RowAction, TableColumn, TableFilter, TableRow } from './data-table.types';

const COLUMNS: TableColumn[] = [{ key: 'name', labelKey: 'x.name' }];

interface FakeHttp {
  get: (...args: unknown[]) => unknown;
  post?: (...args: unknown[]) => unknown;
  delete?: (...args: unknown[]) => unknown;
}

async function createComponent(opts: {
  http: FakeHttp;
  columns?: TableColumn[];
  rowActions?: RowAction[];
  listActions?: ListAction[];
  filters?: TableFilter[];
  resolveAction?: (actionId: string, row: unknown) => (() => void) | undefined;
  defaultSortKey?: string;
  paged?: boolean;
  pageSize?: number;
  refreshMs?: number;
  refreshOn?: string[];
  sseEvent?: WritableSignal<{ type: string } | null>;
}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: HttpClient, useValue: opts.http as unknown as HttpClient },
      { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      { provide: ConfirmationService, useValue: { confirm: () => Promise.resolve(true) } },
      {
        provide: SseService,
        useValue: { lastEvent: opts.sseEvent ?? signal(null) } as unknown as SseService,
      },
    ],
  });
  const fixture = TestBed.createComponent(DataTableComponent);
  fixture.componentRef.setInput('titleKey', 'x.title');
  fixture.componentRef.setInput('listUrl', '/api/x');
  fixture.componentRef.setInput('columns', opts.columns ?? COLUMNS);
  if (opts.rowActions) fixture.componentRef.setInput('rowActions', opts.rowActions);
  if (opts.listActions) fixture.componentRef.setInput('listActions', opts.listActions);
  if (opts.filters) fixture.componentRef.setInput('filters', opts.filters);
  if (opts.resolveAction) fixture.componentRef.setInput('resolveAction', opts.resolveAction);
  if (opts.defaultSortKey) fixture.componentRef.setInput('defaultSortKey', opts.defaultSortKey);
  if (opts.paged) fixture.componentRef.setInput('paged', opts.paged);
  if (opts.pageSize) fixture.componentRef.setInput('pageSize', opts.pageSize);
  if (opts.refreshMs) fixture.componentRef.setInput('refreshMs', opts.refreshMs);
  if (opts.refreshOn) fixture.componentRef.setInput('refreshOn', opts.refreshOn);
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
  return fixture;
}

describe('DataTableComponent — characterisation', () => {
  it('loads rows from the declared route', async () => {
    const fixture = await createComponent({ http: { get: () => of([{ id: 1, name: 'A' }]) } });
    expect(fixture.componentInstance.rows()).toEqual([{ id: 1, name: 'A' }]);
  });

  it('shows a translated error when the list fails', async () => {
    const fixture = await createComponent({ http: { get: () => { throw new Error('boom'); } } });
    expect(fixture.componentInstance.listError()).not.toBe('');
  });

  it('sorts once by the declared default key', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 2, name: 'B' }, { id: 1, name: 'A' }]) },
      defaultSortKey: 'name',
    });
    expect(fixture.componentInstance.rows().map((r) => r['id'])).toEqual([1, 2]);
  });

  it('omits a row action whose actionId is unknown to the host', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.unknown' }],
      resolveAction: () => undefined,
    });
    expect(fixture.componentInstance.visibleActions({ id: 1, name: 'A' })).toHaveLength(0);
  });

  it('renders a row action whose actionId the host resolves', async () => {
    const handler = vi.fn();
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.known' }],
      resolveAction: (id) => (id === 'core.known' ? handler : undefined),
    });
    const [item] = fixture.componentInstance.visibleActions({ id: 1, name: 'A' });
    expect(item).toBeDefined();
    item.run();
    expect(handler).toHaveBeenCalled();
  });

  it('VERDICT: a resolved `action`-kind row action renders a real button that invokes the handler on click', async () => {
    const handler = vi.fn();
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.known' }],
      resolveAction: (id) => (id === 'core.known' ? handler : undefined),
    });
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const button = buttons.find((b) => b.textContent?.includes('x.doit'));
    expect(button).toBeDefined();
    button!.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('formats a bytes/percent/date column instead of printing the raw value', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, size: 1536, progress: 42.7, updatedAt: '2026-01-02' }]) },
      columns: [
        { key: 'size', labelKey: 'x.size', format: 'bytes' },
        { key: 'progress', labelKey: 'x.progress', format: 'percent' },
        { key: 'updatedAt', labelKey: 'x.updated', format: 'date' },
      ],
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('1.5 KB');
    expect(text).not.toContain('1536');
    expect(text).toContain('43%');
    expect(text).not.toContain('42.7');
    expect(text).not.toContain('2026-01-02');
  });

  it('renders a paged response\'s rows and pager, keyed off `paged`', async () => {
    const get = vi.fn(() => of({ data: [{ id: 1, name: 'A' }], total: 40, page: 1, pageSize: 20 }));
    const fixture = await createComponent({ http: { get }, paged: true, pageSize: 20 });
    expect(fixture.componentInstance.rows()).toEqual([{ id: 1, name: 'A' }]);
    expect(fixture.componentInstance.totalPages()).toBe(2);
    expect((fixture.nativeElement as HTMLElement).querySelector('nav')).not.toBeNull();
    const [, options] = get.mock.calls[0] as unknown as [string, { params: { toString(): string } }];
    expect(options.params.toString()).toBe('page=1&pageSize=20');
  });

  it('still renders a bare-array response when `paged` is unset', async () => {
    const fixture = await createComponent({ http: { get: () => of([{ id: 1, name: 'A' }]) } });
    expect(fixture.componentInstance.rows()).toEqual([{ id: 1, name: 'A' }]);
    expect((fixture.nativeElement as HTMLElement).querySelector('nav')).toBeNull();
  });

  it('renders a listAction once above the rows, and running it reloads', async () => {
    const post = vi.fn(() => of({}));
    const get = vi.fn(() => of([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]));
    const fixture = await createComponent({
      http: { get, post },
      listActions: [{ labelKey: 'x.clear', method: 'POST', path: '/api/x/clear' }],
    });
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const matches = buttons.filter((b) => b.textContent?.includes('x.clear'));
    expect(matches).toHaveLength(1);
    await fixture.componentInstance.runListAction({ labelKey: 'x.clear', method: 'POST', path: '/api/x/clear' });
    expect(post).toHaveBeenCalledWith('/api/x/clear', {});
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('confirms before running a proxy action, then reloads', async () => {
    const post = vi.fn(() => of({}));
    const get = vi.fn(() => of([{ id: 1, name: 'A' }]));
    const fixture = await createComponent({
      http: { get, post },
      rowActions: [{ kind: 'proxy', labelKey: 'x.grab', method: 'POST', path: '/api/x/1/grab', confirmKey: 'x.confirm' }],
    });
    const [item] = fixture.componentInstance.visibleActions({ id: 1, name: 'A' });
    await item.run();
    expect(post).toHaveBeenCalledWith('/api/x/1/grab', {});
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('DataTableComponent — declared filters', () => {
  const SEARCH: TableFilter = { kind: 'search', key: 'q', placeholderKey: 'x.search' };
  const STATUS: TableFilter = {
    kind: 'select',
    key: 'status',
    labelKey: 'x.status',
    options: [{ value: '', labelKey: 'x.all' }, { value: 'failed', labelKey: 'x.failed' }],
  };

  it('VERDICT: typing in a search filter sends it as a query param, debounced, and resets the page', async () => {
    const get = vi.fn(() => of({ data: [{ id: 1, name: 'A' }], total: 40, page: 1, pageSize: 20 }));
    const fixture = await createComponent({ http: { get }, paged: true, filters: [SEARCH] });
    await fixture.componentInstance.goToPage(2);
    get.mockClear();

    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Debounced: the keystroke alone must not have fired a request yet.
    expect(get).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 350));
    fixture.detectChanges();

    expect(get).toHaveBeenCalledTimes(1);
    const [, options] = get.mock.calls[0] as unknown as [string, { params: { toString(): string } }];
    expect(options.params.toString()).toBe('q=abc&page=1&pageSize=20');
  });

  it('VERDICT: a select filter reloads immediately and resets the page', async () => {
    const get = vi.fn(() => of({ data: [{ id: 1, name: 'A' }], total: 40, page: 1, pageSize: 20 }));
    const fixture = await createComponent({ http: { get }, paged: true, filters: [STATUS] });
    await fixture.componentInstance.goToPage(2);
    get.mockClear();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(get).toHaveBeenCalledTimes(1);
    const [, options] = get.mock.calls[0] as unknown as [string, { params: { toString(): string } }];
    expect(options.params.toString()).toBe('status=failed&page=1&pageSize=20');
  });

  it('sends a declared filter on an unpaged (bare-array) list too', async () => {
    const get = vi.fn(() => of([{ id: 1, name: 'A' }]));
    const fixture = await createComponent({ http: { get }, filters: [STATUS] });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    const last = get.mock.calls.at(-1) as unknown as [string, { params: { toString(): string } }];
    expect(last[1].params.toString()).toBe('status=failed');
  });

  it('VERDICT: clearing a filter drops the param instead of sending it blank', async () => {
    const get = vi.fn(() => of([{ id: 1, name: 'A' }]));
    const fixture = await createComponent({ http: { get }, filters: [STATUS] });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    const last = get.mock.calls.at(-1) as unknown as [string, { params: { toString(): string } }];
    expect(last[1].params.toString()).toBe('');
  });

  it('VERDICT: the rendered selection comes from state, not from a prior DOM write', async () => {
    const fixture = await createComponent({ http: { get: () => of([{ id: 1, name: 'A' }]) }, filters: [STATUS] });

    fixture.componentInstance.filterValues.set({ status: 'failed' });
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('failed');
  });

  it('VERDICT: a superseded reload never overwrites the rows of the newest one', async () => {
    const pending: Subject<TableRow[]>[] = [];
    const get = vi.fn(() => {
      const subject = new Subject<TableRow[]>();
      pending.push(subject);
      return subject.asObservable();
    });
    const fixture = await createComponent({ http: { get }, filters: [STATUS] });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2);

    // The newest request answers first; the slow initial one must not win the race.
    pending[1].next([{ id: 2, name: 'newest' }]);
    pending[1].complete();
    await new Promise((r) => setTimeout(r, 0));
    pending[0].next([{ id: 1, name: 'stale' }]);
    pending[0].complete();
    await new Promise((r) => setTimeout(r, 0));

    expect(fixture.componentInstance.rows().map((r) => r['name'])).toEqual(['newest']);
  });

  it('renders a declared value label for a cell instead of its raw value', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, status: 'failed' }]) },
      columns: [{ key: 'status', labelKey: 'x.status', labelKeys: { failed: 'x.failed_label' } }],
    });
    expect(fixture.componentInstance.cellLabel(fixture.componentInstance.columns()[0], 'failed')).toBe('x.failed_label');
    expect(fixture.componentInstance.cellLabel(fixture.componentInstance.columns()[0], 'other')).toBe('other');
  });

  it('VERDICT: a declared badge renders as a badge span, and an undeclared tone cannot reach the class', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, status: 'failed', quality: 'WEBDL-1080p', title: 'A' }]) },
      columns: [
        { key: 'status', labelKey: 'x.status', badges: { failed: 'error', completed: 'success' } },
        { key: 'quality', labelKey: 'x.quality', badges: { '*': 'ghost' } },
        { key: 'title', labelKey: 'x.title' },
      ],
    });
    const c = fixture.componentInstance;
    const [status, quality, title] = c.columns();

    expect(c.badgeClass(status, 'failed')).toBe('badge-error');
    expect(c.badgeClass(status, 'completed')).toBe('badge-success');
    // Not named and no `*`: text, not a badge with an empty tone.
    expect(c.badgeClass(status, 'importing')).toBeNull();
    // `*` gives an open-ended column one uniform tone.
    expect(c.badgeClass(quality, 'WEBDL-1080p')).toBe('badge-ghost');
    expect(c.badgeClass(title, 'A')).toBeNull();
    // A manifest is untrusted JSON: an unknown tone resolves to a known class, never itself.
    const hostile = { key: 'status', labelKey: 'x.status', badges: { failed: 'error" onmouseover="x' } } as unknown as TableColumn;
    expect(c.badgeClass(hostile, 'failed')).toBe('badge-ghost');

    const badges = fixture.nativeElement.querySelectorAll('td span.badge');
    expect(badges.length).toBe(2);
    expect(badges[0].className).toContain('badge-error');
  });

  it('VERDICT: a cell with a detail opens a dialog showing it, and one without is not a button', async () => {
    const fixture = await createComponent({
      http: {
        get: () =>
          of([
            { id: 1, status: 'failed', statusMessage: 'tracker refused: 403' },
            { id: 2, status: 'completed', statusMessage: null },
          ]),
      },
      columns: [
        {
          key: 'status',
          labelKey: 'x.status',
          badges: { failed: 'error', completed: 'success' },
          detailField: 'statusMessage',
          detailTitleKey: 'x.detail_title',
        },
      ],
    });
    const c = fixture.componentInstance;
    const [status] = c.columns();
    const rows = c.rows();

    expect(c.detailText(status, rows[0])).toBe('tracker refused: 403');
    // Nothing to show: the badge stays inert rather than opening an empty dialog.
    expect(c.detailText(status, rows[1])).toBe('');
    expect(fixture.nativeElement.querySelectorAll('tbody button').length).toBe(1);

    c.openDetail(status, rows[1]);
    expect(c.detail()).toBeNull();

    c.openDetail(status, rows[0]);
    expect(c.detail()).toEqual({ titleKey: 'x.detail_title', text: 'tracker refused: 403' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog pre').textContent).toContain('403');

    c.closeDetail();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog')).toBeNull();
  });

  it('renders declared sub-values under the cell, skipping the ones the row has no value for', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, title: 'A Release', quality: 'WEBDL-1080p', source: '' }]) },
      columns: [
        {
          key: 'title',
          labelKey: 'x.title',
          subValues: [
            { key: 'quality', badges: { '*': 'ghost' } },
            { key: 'source', badges: { '*': 'neutral' } },
          ],
        },
      ],
    });
    const badges = fixture.nativeElement.querySelectorAll('tbody td span.badge');
    // `source` is empty on this row: no badge for it, rather than an empty one.
    expect(badges.length).toBe(1);
    expect(badges[0].textContent.trim()).toBe('WEBDL-1080p');
  });

  it('keeps formatted, badged and declared-nowrap cells on one line', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, size: 1024, status: 'failed', source: 'x', title: 'A' }]) },
      columns: [
        { key: 'size', labelKey: 'x.size', format: 'bytes' },
        { key: 'status', labelKey: 'x.status', badges: { failed: 'error' } },
        { key: 'source', labelKey: 'x.source', nowrap: true },
        { key: 'title', labelKey: 'x.title' },
      ],
    });
    const c = fixture.componentInstance;
    expect(c.columns().map((col) => c.cellNowrap(col))).toEqual([true, true, true, false]);

    const cells = fixture.nativeElement.querySelectorAll('tbody tr td');
    expect(cells[3].className).not.toContain('whitespace-nowrap');
    expect(cells[0].className).toContain('whitespace-nowrap');
  });

  it('VERDICT: a select change inside the search debounce window does not double-fire the request', async () => {
    const get = vi.fn(() => of({ data: [{ id: 1, name: 'A' }], total: 40, page: 1, pageSize: 20 }));
    const fixture = await createComponent({ http: { get }, paged: true, filters: [SEARCH, STATUS] });
    get.mockClear();

    vi.useFakeTimers();
    try {
      const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
      input.value = 'abc';
      input.dispatchEvent(new Event('input'));

      const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
      select.value = 'failed';
      select.dispatchEvent(new Event('change'));
      await vi.advanceTimersByTimeAsync(0);

      // The select's own reload already ran; the still-armed search timer must not fire a second one.
      await vi.advanceTimersByTimeAsync(350);
    } finally {
      vi.useRealTimers();
    }

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('renders no control for an unrecognised filter kind (fail closed)', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      filters: [{ kind: 'bogus' } as unknown as TableFilter],
    });
    expect(fixture.nativeElement.querySelectorAll('input[type="search"], select')).toHaveLength(0);
  });
});

describe('DataTableComponent — formatting the moving values', () => {
  it('states the unit on a speed, so a number is not read as a size', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, bytesPerSecond: 1536 }]) },
      columns: [{ key: 'bytesPerSecond', labelKey: 'x.speed', format: 'speed' }],
    });
    expect(fixture.nativeElement.textContent).toContain('1.5 KB/s');
  });

  it('leaves a non-numeric speed alone rather than printing NaN/s', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, bytesPerSecond: null }]) },
      columns: [{ key: 'bytesPerSecond', labelKey: 'x.speed', format: 'speed' }],
    });
    expect(fixture.nativeElement.textContent).not.toContain('/s');
  });

  it('clips a truncated cell to one line and keeps the full text reachable', async () => {
    const long = 'A release name long enough to wrap a phone over several lines';
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, title: long }]) },
      columns: [{ key: 'title', labelKey: 'x.title', truncate: true }],
    });
    const span = fixture.nativeElement.querySelector('td span.truncate') as HTMLElement;
    expect(span).toBeTruthy();
    expect(span.getAttribute('title')).toBe(long);
    // A truncated cell must not also be nowrap: that would size the column to the
    // content and there would be nothing left to clip.
    expect(fixture.componentInstance.cellNowrap({ key: 'title', labelKey: 'x', truncate: true })).toBe(false);
  });
});

describe('DataTableComponent — refreshing', () => {
  it('reloads on demand', async () => {
    const get = vi.fn(() => of([{ id: 1 }]));
    const fixture = await createComponent({ http: { get } });
    const before = get.mock.calls.length;
    await fixture.componentInstance.refreshNow();
    expect(get.mock.calls.length).toBe(before + 1);
  });

  it('coalesces a burst of events into one fetch, then catches up with the last', async () => {
    const get = vi.fn(() => of([{ id: 1 }]));
    const event = signal<{ type: string } | null>(null);
    // The component has to exist before the clock is frozen: creating it awaits a real timer.
    const fixture = await createComponent({
      http: { get },
      refreshOn: ['queue.updated'],
      sseEvent: event,
    });
    vi.useFakeTimers();
    try {
      const before = get.mock.calls.length;

      event.set({ type: 'queue.updated' });
      fixture.detectChanges();
      expect(get.mock.calls.length).toBe(before + 1);

      // Same window: the second and third must not each cost a round trip...
      event.set({ type: 'queue.updated', ...{ n: 2 } });
      fixture.detectChanges();
      event.set({ type: 'queue.updated', ...{ n: 3 } });
      fixture.detectChanges();
      expect(get.mock.calls.length).toBe(before + 1);

      // ...but the last one must still land, or the table keeps a state the server left.
      await vi.advanceTimersByTimeAsync(2100);
      expect(get.mock.calls.length).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an event type the page did not declare', async () => {
    const get = vi.fn(() => of([{ id: 1 }]));
    const event = signal<{ type: string } | null>(null);
    const fixture = await createComponent({ http: { get }, refreshOn: ['queue.updated'], sseEvent: event });
    const before = get.mock.calls.length;
    event.set({ type: 'something.else' });
    fixture.detectChanges();
    expect(get.mock.calls.length).toBe(before);
  });

  it('refreshes nothing while nobody is looking at the page', async () => {
    const get = vi.fn(() => of([{ id: 1 }]));
    const event = signal<{ type: string } | null>(null);
    const fixture = await createComponent({ http: { get }, refreshOn: ['queue.updated'], sseEvent: event });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const before = get.mock.calls.length;
      event.set({ type: 'queue.updated' });
      fixture.detectChanges();
      expect(get.mock.calls.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
