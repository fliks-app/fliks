import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DataTableComponent } from './data-table';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ListAction, RowAction, TableColumn } from './data-table.types';

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
  resolveAction?: (actionId: string, row: unknown) => (() => void) | undefined;
  defaultSortKey?: string;
  paged?: boolean;
  pageSize?: number;
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
    ],
  });
  const fixture = TestBed.createComponent(DataTableComponent);
  fixture.componentRef.setInput('titleKey', 'x.title');
  fixture.componentRef.setInput('listUrl', '/api/x');
  fixture.componentRef.setInput('columns', opts.columns ?? COLUMNS);
  if (opts.rowActions) fixture.componentRef.setInput('rowActions', opts.rowActions);
  if (opts.listActions) fixture.componentRef.setInput('listActions', opts.listActions);
  if (opts.resolveAction) fixture.componentRef.setInput('resolveAction', opts.resolveAction);
  if (opts.defaultSortKey) fixture.componentRef.setInput('defaultSortKey', opts.defaultSortKey);
  if (opts.paged) fixture.componentRef.setInput('paged', opts.paged);
  if (opts.pageSize) fixture.componentRef.setInput('pageSize', opts.pageSize);
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
