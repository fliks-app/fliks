import { WritableSignal, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateLoader, TranslateService, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { vi } from 'vitest';
import { DataTableComponent } from './data-table';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { ListAction, RowAction, TableColumn, TableFilter, TableRow } from './data-table.types';

const COLUMNS: TableColumn[] = [{ key: 'name', labelKey: 'x.name' }];

// jsdom has no scrollIntoView; the row menu focuses its first item through it.
Element.prototype.scrollIntoView ??= () => {};

// …nor the <dialog> methods the detail dialogs are driven by.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

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
  confirmation?: unknown;
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
      {
        provide: ConfirmationService,
        useValue: opts.confirmation ?? {
          confirm: () => Promise.resolve(true),
          confirmWithToggle: () => Promise.resolve({ ok: true, toggle: true }),
        },
      },
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

  it('VERDICT: a resolved `action`-kind row action renders a real button in the row menu that invokes the handler on click', async () => {
    const handler = vi.fn();
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.known' }],
      resolveAction: (id) => (id === 'core.known' ? handler : undefined),
    });
    const kebab = fixture.nativeElement.querySelector('tbody td button') as HTMLButtonElement;
    kebab.click();
    fixture.detectChanges();
    await fixture.whenStable();
    // The popover moves its content under <html>, so it is no longer inside the fixture.
    const button = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('x.doit'),
    ) as HTMLButtonElement | undefined;
    expect(button).toBeDefined();
    button!.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('VERDICT: keeps a `detail` action on the row and moves the acting ones into the menu', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      rowActions: [
        { kind: 'detail', labelKey: 'x.info', fields: [] },
        { kind: 'proxy', labelKey: 'x.stop', method: 'DELETE', path: '/api/x/:id' },
      ],
    });
    const row = { id: 1, name: 'A' };
    expect(fixture.componentInstance.inlineActions(row).map((i) => i.action.labelKey)).toEqual([
      'x.info',
    ]);
    expect(fixture.componentInstance.menuActions(row).map((i) => i.action.labelKey)).toEqual([
      'x.stop',
    ]);
    // The row shows the detail button plus the menu trigger (icon only), nothing else.
    const cellButtons = Array.from(
      fixture.nativeElement.querySelectorAll('tbody td button'),
    ) as HTMLButtonElement[];
    expect(cellButtons.map((b) => b.textContent?.trim())).toEqual(['x.info', '']);
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
    const dialog = Array.from(
      fixture.nativeElement.querySelectorAll('dialog') as NodeListOf<HTMLDialogElement>,
    ).find((d) => d.querySelector('pre'))!;
    expect(dialog.hasAttribute('open')).toBe(true);

    c.closeDetail();
    fixture.detectChanges();
    // The element stays mounted so daisyUI can animate the close; `open` is what shows it.
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(dialog.isConnected).toBe(true);
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

/**
 * The spinner is raised by a visible load and cleared by whichever load finishes
 * last. Gating that clear on the *finishing* load being visible stranded it: an
 * automatic refresh that lands mid-load bars the load it superseded from
 * clearing, then declines to clear it itself.
 */
describe('DataTableComponent — the spinner always comes down', () => {
  it('clears when a silent refresh supersedes the load that raised it', async () => {
    const http: FakeHttp = { get: () => of([{ id: 1, name: 'a' }] as TableRow[]) };

    const fixture = await createComponent({ http });
    const table = fixture.componentInstance as unknown as {
      loading: WritableSignal<boolean>;
      loadRows: (o?: { silent?: boolean }) => Promise<void>;
    };
    // A visible load raised the spinner and was then superseded, so it can no
    // longer clear it — the auto-refresh below is the only one left that can.
    table.loading.set(true);

    await table.loadRows({ silent: true });

    expect(table.loading()).toBe(false);
  });
});

describe('DataTableComponent — row-scoped proxy actions', () => {
  const ROW = { id: 7, name: 'A', state: 'active' };

  it('VERDICT: substitutes :id with the row it sits on — a shared path would hit one row for all', async () => {
    const del = vi.fn(() => of({}));
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: del },
      rowActions: [{ kind: 'proxy', labelKey: 'x.rm', method: 'DELETE', path: '/api/p/queue/:id' }],
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect(del).toHaveBeenCalledWith('/api/p/queue/7');
  });

  it('renders an action whose visibleWhen matches the row', async () => {
    const fixture = await createComponent({
      http: { get: () => of([ROW]) },
      rowActions: [
        {
          kind: 'proxy',
          labelKey: 'x.pause',
          method: 'POST',
          path: '/api/p/queue/:id/pause',
          visibleWhen: { key: 'state', in: ['active', 'stalled'] },
        },
      ],
    });
    expect(fixture.componentInstance.visibleActions(ROW).length).toBe(1);
  });

  it('VERDICT: hides it when the row is in another state — pausing a paused row is a button that fails', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ ...ROW, state: 'paused' }]) },
      rowActions: [
        {
          kind: 'proxy',
          labelKey: 'x.pause',
          method: 'POST',
          path: '/api/p/queue/:id/pause',
          visibleWhen: { key: 'state', in: ['active', 'stalled'] },
        },
      ],
    });
    expect(fixture.componentInstance.visibleActions({ ...ROW, state: 'paused' })).toEqual([]);
  });

  it('fails closed on a condition naming a field the row does not carry', async () => {
    const fixture = await createComponent({
      http: { get: () => of([ROW]) },
      rowActions: [
        {
          kind: 'proxy',
          labelKey: 'x.pause',
          method: 'POST',
          path: '/api/p/queue/:id/pause',
          visibleWhen: { key: 'nosuchfield', in: ['active'] },
        },
      ],
    });
    expect(fixture.componentInstance.visibleActions(ROW)).toEqual([]);
  });
});

describe('DataTableComponent — a confirmation that carries a decision', () => {
  const ROW = { id: 7, name: 'A' };
  const REMOVE: RowAction = {
    kind: 'proxy',
    labelKey: 'x.rm',
    method: 'DELETE',
    path: '/api/p/queue/:id',
    confirmKey: 'x.confirm_rm',
    confirmToggle: { labelKey: 'x.delete_files', param: 'deleteFiles' },
  };

  it('passes the hint through to the confirmation, for what the choice does not do', async () => {
    let seen: { toggleHint?: string } | undefined;
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: () => of({}) },
      rowActions: [{ ...REMOVE, confirmToggle: { labelKey: 'x.delete_files', param: 'deleteFiles', hintKey: 'x.kept' } }],
      confirmation: {
        confirmWithToggle: (o: { toggleHint?: string }) => {
          seen = o;
          return Promise.resolve({ ok: false, toggle: false });
        },
      },
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect(seen?.toggleHint).toBe('x.kept');
  });

  it('sends no hint when the action declares none', async () => {
    let seen: { toggleHint?: string } | undefined;
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: () => of({}) },
      rowActions: [REMOVE],
      confirmation: {
        confirmWithToggle: (o: { toggleHint?: string }) => {
          seen = o;
          return Promise.resolve({ ok: false, toggle: false });
        },
      },
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect('toggleHint' in (seen ?? {})).toBe(false);
  });

  it("VERDICT: sends the checkbox's answer, not its default", async () => {
    const del = vi.fn(() => of({}));
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: del },
      rowActions: [REMOVE],
      confirmation: { confirmWithToggle: () => Promise.resolve({ ok: true, toggle: false }) },
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect(del).toHaveBeenCalledWith('/api/p/queue/7?deleteFiles=false');
  });

  it('calls nothing when the confirmation is declined', async () => {
    const del = vi.fn(() => of({}));
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: del },
      rowActions: [REMOVE],
      confirmation: { confirmWithToggle: () => Promise.resolve({ ok: false, toggle: true }) },
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect(del).not.toHaveBeenCalled();
  });

  it('a toggle declared without a confirmKey is dropped rather than sent silently', async () => {
    const del = vi.fn(() => of({}));
    const fixture = await createComponent({
      http: { get: () => of([ROW]), delete: del },
      rowActions: [{ ...REMOVE, confirmKey: undefined }],
    });
    await fixture.componentInstance.visibleActions(ROW)[0].run();
    expect(del).toHaveBeenCalledWith('/api/p/queue/7');
  });
});

describe('DataTableComponent — progress inside a badge', () => {
  const COL: TableColumn = {
    key: 'state',
    labelKey: 'x.state',
    badges: { active: 'info' },
    progressField: 'progress',
  };

  it('rounds the named field into a 0–100 fill', async () => {
    const fixture = await createComponent({ http: { get: () => of([]) } });
    expect(fixture.componentInstance.cellProgress(COL, { id: 1, state: 'active', progress: 47.4 })).toBe(47);
  });

  it('VERDICT: a row reporting no number stays flat — an unreachable client is not 0%', async () => {
    const fixture = await createComponent({ http: { get: () => of([]) } });
    expect(fixture.componentInstance.cellProgress(COL, { id: 1, state: 'active', progress: null })).toBeNull();
  });

  it('a column declaring no progressField never fills', async () => {
    const fixture = await createComponent({ http: { get: () => of([]) } });
    expect(
      fixture.componentInstance.cellProgress({ key: 'state', labelKey: 'x.state' }, { id: 1, progress: 50 }),
    ).toBeNull();
  });
});

describe('DataTableComponent — the detail row action', () => {
  const ROW = {
    id: 7,
    name: 'A',
    quality: 'WEBDL-1080p',
    infoUrl: 'https://tracker.example/details/42',
    empty: '',
  };
  const DETAIL: RowAction = {
    kind: 'detail',
    labelKey: 'x.info',
    titleKey: 'x.info_title',
    fields: [
      { key: 'quality', labelKey: 'x.quality' },
      { key: 'empty', labelKey: 'x.empty' },
      { kind: 'link', key: 'infoUrl', labelKey: 'x.indexer', textKey: 'x.open_on_indexer' },
    ],
  };

  const openDetail = async (row: TableRow, action: RowAction = DETAIL) => {
    const fixture = await createComponent({ http: { get: () => of([row]) }, rowActions: [action] });
    await fixture.componentInstance.visibleActions(row)[0].run();
    return fixture.componentInstance.rowDetail()!;
  };

  it('opens a dialog titled by titleKey, skipping fields the row leaves empty', async () => {
    const open = await openDetail(ROW);
    expect(open.titleKey).toBe('x.info_title');
    expect(open.lines.map((l) => l.labelKey)).toEqual(['x.quality', 'x.indexer']);
  });

  it('anchors a link field to the row url', async () => {
    const open = await openDetail(ROW);
    expect(open.lines.find((l) => l.labelKey === 'x.indexer')?.href).toBe(
      'https://tracker.example/details/42',
    );
  });

  it('VERDICT: refuses a non-http url — a row value is indexer data, not manifest data', async () => {
    // eslint-disable-next-line no-script-url
    const open = await openDetail({ ...ROW, infoUrl: 'javascript:alert(1)' });
    expect(open.lines.map((l) => l.labelKey)).toEqual(['x.quality']);
  });

  it('refuses a value that is not a url at all', async () => {
    const open = await openDetail({ ...ROW, infoUrl: 'not a url' });
    expect(open.lines.map((l) => l.labelKey)).toEqual(['x.quality']);
  });
});

describe('DataTableComponent — a cell that links', () => {
  const COL: TableColumn = { key: 'name', labelKey: 'x.name', linkActionId: 'table.open-media' };

  it('renders a handler when core resolves the action for the row', async () => {
    const run = vi.fn();
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      columns: [COL],
      resolveAction: () => run,
    });
    fixture.componentInstance.cellLink(COL, { id: 1, name: 'A' })!();
    expect(run).toHaveBeenCalled();
  });

  it('VERDICT: plain text when the row cannot resolve it, never a dead link', async () => {
    const fixture = await createComponent({
      http: { get: () => of([{ id: 1, name: 'A' }]) },
      columns: [COL],
      resolveAction: () => undefined,
    });
    expect(fixture.componentInstance.cellLink(COL, { id: 1, name: 'A' })).toBeUndefined();
  });

  it('a column declaring no linkActionId never links', async () => {
    const fixture = await createComponent({ http: { get: () => of([]) }, resolveAction: () => vi.fn() });
    expect(fixture.componentInstance.cellLink({ key: 'name', labelKey: 'x' }, { id: 1 })).toBeUndefined();
  });
});

describe('DataTableComponent — a plugin message that is an i18n key', () => {
  // `detailField` and a `detail` field both carry whatever the plugin put on the row: sometimes
  // one of its own keys, sometimes raw text from a filesystem or an HTTP client.
  const TRANSLATED = 'plugin.msg.removed';
  const COL: TableColumn = { key: 'status', labelKey: 'x.status', detailField: 'statusMessage' };

  async function withTranslation(row: TableRow) {
    const fixture = await createComponent({ http: { get: () => of([row]) }, columns: [COL] });
    // `instant` echoes an unknown key back, which is what the fallback keys off.
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', { [TRANSLATED]: 'Removed by an operator' }, true);
    return fixture;
  }

  it('VERDICT: renders the declared wording, not the raw key', async () => {
    const row = { id: 1, status: 'failed', statusMessage: TRANSLATED };
    const fixture = await withTranslation(row);
    expect(fixture.componentInstance.detailText(COL, row)).toBe('Removed by an operator');
  });

  it('leaves raw text alone — a filesystem error is not a key', async () => {
    const row = { id: 1, status: 'failed', statusMessage: 'ENOENT: no such file' };
    const fixture = await withTranslation(row);
    expect(fixture.componentInstance.detailText(COL, row)).toBe('ENOENT: no such file');
  });

  it('a row with no message opens nothing', async () => {
    const row = { id: 1, status: 'failed', statusMessage: '' };
    const fixture = await withTranslation(row);
    expect(fixture.componentInstance.detailText(COL, row)).toBe('');
  });
});
