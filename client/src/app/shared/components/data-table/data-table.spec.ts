import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DataTableComponent } from './data-table';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { RowAction, TableColumn } from './data-table.types';

const COLUMNS: TableColumn[] = [{ key: 'name', labelKey: 'x.name' }];

interface FakeHttp {
  get: (...args: unknown[]) => unknown;
  post?: (...args: unknown[]) => unknown;
  delete?: (...args: unknown[]) => unknown;
}

async function createComponent(opts: {
  http: FakeHttp;
  rowActions?: RowAction[];
  resolveAction?: (actionId: string, row: unknown) => (() => void) | undefined;
  defaultSortKey?: string;
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
  fixture.componentRef.setInput('columns', COLUMNS);
  if (opts.rowActions) fixture.componentRef.setInput('rowActions', opts.rowActions);
  if (opts.resolveAction) fixture.componentRef.setInput('resolveAction', opts.resolveAction);
  if (opts.defaultSortKey) fixture.componentRef.setInput('defaultSortKey', opts.defaultSortKey);
  fixture.detectChanges();
  await fixture.whenStable();
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
