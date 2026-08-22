import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ProviderListComponent, resolveRowActionRoute } from './provider-list';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ProviderImplementation, ProviderListAction, ProviderListLabels, ProviderRowAction } from './provider-list.types';

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

const STATS_RESULT: NonNullable<ProviderRowAction['result']> = {
  kind: 'table',
  emptyKey: 'x.stats_empty',
  columns: [{ key: 'date', labelKey: 'x.stats_date' }],
};

const LABELS: ProviderListLabels = {
  newLabelKey: 'x.new',
  colNameKey: 'x.col_name',
  colImplementationKey: 'x.col_impl',
  colPriorityKey: 'x.col_priority',
  colEnabledKey: 'x.col_enabled',
  actionsKey: 'x.actions',
  editKey: 'x.edit',
  deleteKey: 'x.delete',
  saveKey: 'x.save',
  cancelKey: 'x.cancel',
  createTitleKey: 'x.create',
  editTitleKey: 'x.edit_title',
  fieldNameKey: 'x.field_name',
  fieldImplementationKey: 'x.field_impl',
  fieldPriorityKey: 'x.field_priority',
  fieldEnabledKey: 'x.field_enabled',
  emptyKey: 'x.empty',
  loadErrorKey: 'x.load_error',
  confirmDeleteKey: 'x.confirm_delete',
  deleteErrorKey: 'x.delete_error',
};

const IMPLS: ProviderImplementation[] = [
  {
    implementation: 'demo',
    labelKey: 'x.impl_demo',
    fields: [
      { key: 'url', type: 'url', labelKey: 'x.field_url', required: true },
      { key: 'apiKey', type: 'password', labelKey: 'x.field_api_key', secret: true },
      { key: 'delay', type: 'number', labelKey: 'x.field_delay', default: 2, topLevel: true },
    ],
  },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
interface FakeHttp {
  get: (...a: any[]) => unknown;
  post?: (...a: any[]) => unknown;
  put?: (...a: any[]) => unknown;
  delete?: (...a: any[]) => unknown;
  request?: (...a: any[]) => unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function createComponent(
  http: FakeHttp,
  opts: Partial<{
    implementations: ProviderImplementation[];
    reorderable: boolean;
    listActions: ProviderListAction[];
    rowActions: ProviderRowAction[];
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    confirmation: { confirm: (...a: any[]) => Promise<boolean>; alert: (...a: any[]) => Promise<void> };
    labels: ProviderListLabels;
  }> = {},
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: HttpClient, useValue: http as unknown as HttpClient },
      {
        provide: ConfirmationService,
        useValue: opts.confirmation ?? { confirm: () => Promise.resolve(true), alert: () => Promise.resolve() },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProviderListComponent);
  fixture.componentRef.setInput('titleKey', 'x.title');
  fixture.componentRef.setInput('listUrl', '/api/x');
  fixture.componentRef.setInput('implementations', opts.implementations ?? IMPLS);
  fixture.componentRef.setInput('labels', opts.labels ?? LABELS);
  if (opts.reorderable) fixture.componentRef.setInput('reorderable', opts.reorderable);
  if (opts.listActions) fixture.componentRef.setInput('listActions', opts.listActions);
  if (opts.rowActions) fixture.componentRef.setInput('rowActions', opts.rowActions);
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
  return fixture;
}

describe('ProviderListComponent — characterisation', () => {
  it('loads rows from the declared route', async () => {
    const fixture = await createComponent({ get: () => of([{ id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]) });
    expect(fixture.componentInstance.rows()).toHaveLength(1);
  });

  it('renders a translated message when the list fails', async () => {
    const fixture = await createComponent({ get: () => { throw new Error('boom'); } });
    expect(fixture.componentInstance.listError()).not.toBe('');
  });

  it('renders a translated message for an unknown implementation rather than a blank form', async () => {
    const fixture = await createComponent({ get: () => of([]) });
    expect(fixture.componentInstance.implementationLabel('ghost')).not.toBe('');
    expect(fixture.componentInstance.implementationLabel('ghost')).not.toBe('ghost');
  });

  it('never re-sends a secret left untouched, and hoists a topLevel field out of settings', async () => {
    const post = vi.fn((_url: string, _body: unknown) => of({}));
    const fixture = await createComponent({ get: () => of([]), post });
    fixture.componentInstance.openCreate();
    fixture.componentInstance.draftName.set('New');
    fixture.componentInstance.draftValue.update((v) => ({ ...v, url: 'http://x' }));

    await fixture.componentInstance.save();

    expect(post).toHaveBeenCalledTimes(1);
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['delay']).toBe(2);
    expect((body['settings'] as Record<string, unknown>)['delay']).toBeUndefined();
    expect((body['settings'] as Record<string, unknown>)['apiKey']).toBeUndefined();
  });

  it('does not save while a required field is blank', async () => {
    const post = vi.fn((_url: string, _body: unknown) => of({}));
    const fixture = await createComponent({ get: () => of([]), post });
    fixture.componentInstance.openCreate();
    fixture.componentInstance.draftName.set('New');
    await fixture.componentInstance.save();
    expect(post).not.toHaveBeenCalled();
  });

  it('runs testConnection against the draft, not a saved row', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true, message: 'ok' }));
    const fixture = await createComponent({ get: () => of([]) });
    fixture.componentRef.setInput('testConnection', run);
    fixture.detectChanges();
    fixture.componentInstance.openCreate();
    fixture.componentInstance.draftValue.update((v) => ({ ...v, url: 'http://x' }));

    await fixture.componentInstance.runTestConnection();

    // A new draft carries no id, and the blank secret is omitted rather than sent as ''.
    expect(run).toHaveBeenCalledWith({ implementation: 'demo', settings: { url: 'http://x' } });
    expect(fixture.componentInstance.testResult()).toEqual({ ok: true, message: 'ok' });
  });

  it('VERDICT: testing an edit sends the row id and no blank secret, so the stored one is reusable', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true, message: 'ok' }));
    const fixture = await createComponent({
      get: () => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: { url: 'http://x' } }]),
    });
    fixture.componentRef.setInput('testConnection', run);
    fixture.detectChanges();
    fixture.componentInstance.openEdit(fixture.componentInstance.rows()[0]);

    await fixture.componentInstance.runTestConnection();

    expect(run).toHaveBeenCalledWith({ implementation: 'demo', settings: { url: 'http://x' }, id: 7 });
  });

  it('carries the erase of a stored secret through to the save body as an explicit null', async () => {
    const put = vi.fn((_url: string, _body: unknown) => of({}));
    const fixture = await createComponent({
      get: () =>
        of([
          {
            id: 7,
            name: 'A',
            implementation: 'demo',
            enabled: true,
            priority: 1,
            settings: { url: 'http://x', secretsSet: ['apiKey'] },
          },
        ]),
      put,
    });
    fixture.componentInstance.openEdit(fixture.componentInstance.rows()[0]);
    expect(fixture.componentInstance.secretsSet()).toEqual(['apiKey']);

    fixture.componentInstance.draftValue.update((v) => ({ ...v, apiKey: null }));
    await fixture.componentInstance.save();

    const [, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect((body['settings'] as Record<string, unknown>)['apiKey']).toBeNull();
  });

  it('deletes after confirmation and reloads', async () => {
    const del = vi.fn(() => of(undefined));
    const fixture = await createComponent({ get: () => of([]), delete: del });
    await fixture.componentInstance.deleteRow({ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1 });
    expect(del).toHaveBeenCalledWith('/api/x/7');
  });

  it('VERDICT: editing seeds a topLevel field from the row itself, not from settings', async () => {
    const fixture = await createComponent({
      get: () =>
        of([{ id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 1, delay: 9, settings: { delay: 999 } }]),
    });
    fixture.componentInstance.openEdit(fixture.componentInstance.rows()[0]);
    expect(fixture.componentInstance.draftValue()['delay']).toBe(9);
  });

  it('sorts rows by priority and swaps two rows on move, persisting both priorities', async () => {
    const put = vi.fn(() => of({}));
    const fixture = await createComponent(
      {
        get: () =>
          of([
            { id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 20, settings: {} },
            { id: 2, name: 'B', implementation: 'demo', enabled: true, priority: 10, settings: {} },
          ]),
        put,
      },
      { reorderable: true },
    );
    // Priority-sorted: B (10) then A (20).
    expect(fixture.componentInstance.orderedRows().map((r) => r.id)).toEqual([2, 1]);

    await fixture.componentInstance.moveRow(fixture.componentInstance.orderedRows()[1], -1);
    expect(put).toHaveBeenCalledWith('/api/x/1', expect.objectContaining({ priority: 10 }));
    expect(put).toHaveBeenCalledWith('/api/x/2', expect.objectContaining({ priority: 20 }));
  });

  it('renders a listAction once above the rows, and running it reloads', async () => {
    const get = vi.fn(() => of([{ id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const run = vi.fn(() => Promise.resolve());
    const fixture = await createComponent({ get }, { listActions: [{ labelKey: 'x.sync', run }] });
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.filter((b) => b.textContent?.includes('x.sync'))).toHaveLength(1);

    await fixture.componentInstance.runListAction({ labelKey: 'x.sync', run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('renders one button per `scope: "row"` action — stats and clear-cooldown both reachable, not just the first', async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const rowActions: ProviderRowAction[] = [
      { labelKey: 'x.stats', method: 'GET', route: '/api/x/:id/stats', result: STATS_RESULT },
      { labelKey: 'x.clear_cooldown', method: 'DELETE', route: '/api/x/:id/cooldown' },
    ];
    const fixture = await createComponent({ get }, { rowActions });
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.some((b) => b.textContent?.includes('x.stats'))).toBe(true);
    expect(buttons.some((b) => b.textContent?.includes('x.clear_cooldown'))).toBe(true);
  });

  it("substitutes the row id into a GET row action's route and hands it to its declared table", async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const request = vi.fn(() => of({ some: 'stats' }));
    const fixture = await createComponent({ get, request });

    await fixture.componentInstance.runRowAction(fixture.componentInstance.rows()[0], {
      labelKey: 'x.stats',
      method: 'GET',
      route: '/api/x/:id/stats',
      result: STATS_RESULT,
    });

    expect(fixture.componentInstance.resultView()?.url).toBe('/api/x/7/stats');
    expect(fixture.componentInstance.resultView()?.title).toContain('A');
    // The embedded table owns the fetch; the component must not request it a second time.
    expect(request).not.toHaveBeenCalled();
  });

  it('VERDICT: renders no button for a GET row action that declares no result, and opens nothing', async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const request = vi.fn(() => of({ some: 'stats' }));
    const rowActions: ProviderRowAction[] = [{ labelKey: 'x.stats', method: 'GET', route: '/api/x/:id/stats' }];
    const fixture = await createComponent({ get, request }, { rowActions });

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.some((b) => b.textContent?.includes('x.stats'))).toBe(false);

    await fixture.componentInstance.runRowAction(fixture.componentInstance.rows()[0], rowActions[0]);
    expect(fixture.componentInstance.resultView()).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('reloads (rather than alerting) after a mutating row action succeeds', async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const request = vi.fn(() => of({}));
    const fixture = await createComponent({ get, request });
    await fixture.componentInstance.runRowAction(fixture.componentInstance.rows()[0], {
      labelKey: 'x.clear_cooldown',
      method: 'DELETE',
      route: '/api/x/:id/cooldown',
    });
    expect(request).toHaveBeenCalledWith('DELETE', '/api/x/7/cooldown');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('skips the request entirely when the confirm prompt is declined', async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const request = vi.fn(() => of({}));
    const fixture = await createComponent(
      { get, request },
      { confirmation: { confirm: () => Promise.resolve(false), alert: () => Promise.resolve() } },
    );
    await fixture.componentInstance.runRowAction(fixture.componentInstance.rows()[0], {
      labelKey: 'x.clear_cooldown',
      method: 'DELETE',
      route: '/api/x/:id/cooldown',
      confirmKey: 'x.confirm_clear',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('VERDICT: never requests a row action route whose placeholder survives id substitution', async () => {
    const get = vi.fn(() => of([{ id: 7, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const request = vi.fn(() => of({}));
    const fixture = await createComponent({ get, request });
    await fixture.componentInstance.runRowAction(fixture.componentInstance.rows()[0], {
      labelKey: 'x.bad',
      method: 'GET',
      route: '/api/x/:id/:extra',
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('resolveRowActionRoute', () => {
  it('substitutes the row id for :id', () => {
    expect(resolveRowActionRoute('/api/plugins/x/indexers/:id/stats', 7)).toBe('/api/plugins/x/indexers/7/stats');
  });

  it('returns null — never a request — when a placeholder survives substitution', () => {
    expect(resolveRowActionRoute('/api/plugins/x/indexers/:id/:extra', 7)).toBeNull();
  });

  it('returns null when the route never had :id to begin with', () => {
    expect(resolveRowActionRoute('/api/plugins/x/indexers/cooldowns', 7)).toBeNull();
  });
});

describe('ProviderListComponent — editor dialog chrome', () => {
  it('names the dialog from the page, and closes on the ✕ without saving', async () => {
    const get = vi.fn(() => of([{ id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} }]));
    const post = vi.fn(() => of({}));
    const fixture = await createComponent(
      { get, post },
      { labels: { ...LABELS, createTitleKey: 'x.new_indexer' } },
    );

    fixture.componentInstance.openCreate();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('x.new_indexer');

    const close = Array.from(fixture.nativeElement.querySelectorAll('dialog button')).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === '✕',
    ) as HTMLButtonElement | undefined;
    expect(close).toBeTruthy();
    close!.click();
    await fixture.whenStable();

    expect(post).not.toHaveBeenCalled();
    expect(fixture.componentInstance.editingId()).toBeNull();
  });
});
