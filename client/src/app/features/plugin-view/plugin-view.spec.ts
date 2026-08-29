import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, TranslateService, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PluginViewComponent } from './plugin-view';
import { NavbarService } from '../../core/services/navbar.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { AnyConfigPage } from './view-kinds.types';

async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

function createComponent(
  params: { pluginId: string; view: string },
  registry: { hasPlugin: (id: string) => boolean; configPage: (id: string, view: string) => AnyConfigPage | undefined },
) {
  const navigateByUrl = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        // 'ok' stands in for a plugin's own merged messageKey — `PluginI18nService` puts a
        // plugin's dict in this same store, so a real key resolves exactly like this fake one.
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({ ok: 'All good' }) } },
      }),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap(params)) } },
      { provide: Router, useValue: { navigateByUrl } },
      { provide: PluginUiRegistryService, useValue: registry },
      // The real one subscribes to router events; this suite stubs Router.
      {
        provide: NavbarService,
        useValue: { setPageTitle: () => undefined, clearPageTitle: () => undefined },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(PluginViewComponent);
  return { fixture, http, navigateByUrl };
}

describe('PluginViewComponent', () => {
  it('reports unknown_plugin when the plugin is not in the registry', () => {
    const { fixture } = createComponent(
      { pluginId: 'fliks.gone', view: 'settings' },
      { hasPlugin: () => false, configPage: () => undefined },
    );
    expect(fixture.componentInstance.reason()).toBe('unknown_plugin');
  });

  it('reports unknown_view when the plugin exists but has no matching config page', () => {
    const { fixture } = createComponent(
      { pluginId: 'fliks.a', view: 'missing' },
      { hasPlugin: () => true, configPage: () => undefined },
    );
    expect(fixture.componentInstance.reason()).toBe('unknown_view');
  });

  it('renders a real form for a page with no kind, loading stored values under plugin.<id>.', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'settings' },
      {
        hasPlugin: () => true,
        configPage: () => ({ id: 'settings', labelKey: 'x', fields: [{ key: 'apiKey', type: 'text', labelKey: 'y', default: 'd' }] }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/settings', method: 'GET' }).flush({ 'plugin.fliks.a.apiKey': 'stored' });
    await settle(fixture);

    expect(fixture.componentInstance.formValue()['apiKey']).toBe('stored');

    fixture.componentInstance.formValue.set({ apiKey: 'new-value' });
    void fixture.componentInstance.saveForm();
    const req = http.expectOne({ url: '/api/settings', method: 'PUT' });
    expect(req.request.body).toEqual({ data: { 'plugin.fliks.a.apiKey': 'new-value' } });
    req.flush({ ok: true });
    await settle(fixture);
    http.verify();
  });

  it('loads a `status` item from settings but never writes it back on save', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'settings' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          id: 'settings',
          labelKey: 'x',
          fields: [
            { key: 'apiKey', type: 'text', labelKey: 'y' },
            { kind: 'status', labelKey: 'x.last_sync', settingKey: 'last_sync' },
          ],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/settings', method: 'GET' }).flush({
      'plugin.fliks.a.apiKey': 'stored',
      'plugin.fliks.a.last_sync': '2026-08-14',
    });
    await settle(fixture);

    expect(fixture.componentInstance.formValue()['last_sync']).toBe('2026-08-14');
    expect(fixture.nativeElement.textContent).toContain('x.last_sync');
    expect(fixture.nativeElement.textContent).toContain('2026-08-14');

    void fixture.componentInstance.saveForm();
    const req = http.expectOne({ url: '/api/settings', method: 'PUT' });
    // `last_sync` came from the same value() bag as `apiKey` but is never a declared field — a
    // save that forwarded it anyway would race whatever the plugin itself writes there.
    expect(req.request.body).toEqual({ data: { 'plugin.fliks.a.apiKey': 'stored' } });
    req.flush({ ok: true });
    await settle(fixture);
    http.verify();
  });

  it('disables Save while a declared constraint is violated, and re-enables once it is met', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'settings' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          id: 'settings',
          labelKey: 'x',
          fields: [{ key: 'code', type: 'text', labelKey: 'x.code', maxLength: 3 }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/settings', method: 'GET' }).flush({ 'plugin.fliks.a.code': 'nope' });
    await settle(fixture);

    const saveButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find((b) =>
      (b as HTMLButtonElement).textContent?.includes('common.save'),
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fixture.componentInstance.formValue.set({ code: 'ABC' });
    fixture.detectChanges();
    expect(saveButton.disabled).toBe(false);
    http.verify();
  });

  it('VERDICT: types a stored setting by its declared field kind — "false" is off, not a truthy string', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'settings' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          id: 'settings',
          labelKey: 'x',
          fields: [
            { key: 'autoGrab', type: 'toggle', labelKey: 'y', default: true },
            { key: 'unsetToggle', type: 'toggle', labelKey: 'y', default: true },
            { key: 'interval', type: 'number', labelKey: 'y', default: 60 },
            { key: 'samples', type: 'number', labelKey: 'y' },
          ],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/settings', method: 'GET' }).flush({
      'plugin.fliks.a.autoGrab': 'false',
      'plugin.fliks.a.interval': '30',
      'plugin.fliks.a.samples': '',
    });
    await settle(fixture);

    const value = fixture.componentInstance.formValue();
    expect(value['autoGrab']).toBe(false);
    // Unset falls back to the declared default, not to the empty string.
    expect(value['unsetToggle']).toBe(true);
    expect(value['interval']).toBe(30);
    // An empty number stays empty: 0 samples would mean something else entirely.
    expect(value['samples']).toBe('');

    // Every toggle rendered off would look identical to a load that never ran — check the DOM too.
    const boxes = Array.from(fixture.nativeElement.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    http.verify();
  });

  it('renders the providers renderer once the implementations route resolves, and lists rows from the declared route', async () => {
    // Manifest paths are declared relative to the plugin, exactly as a real manifest ships them —
    // if the component ever requests these verbatim instead of proxying them, `http.expectOne` below fails.
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush([
      { implementation: 'demo', labelKey: 'x.demo', fields: [] },
    ]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([
      { id: 1, name: 'A', implementation: 'demo', enabled: true, priority: 1, settings: {} },
    ]);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('A');
    http.verify();
  });

  it('renders a translated warning (not a blank page, not a silently empty form) when the implementations route fails', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush(null, { status: 500, statusText: 'err' });
    await settle(fixture);
    // Falls back to an empty implementations list — the provider renderer still mounts and fetches its own list.
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);
    expect(fixture.componentInstance.implementationsLoadError()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('plugin_view.implementations_load_error');
    http.verify();
  });

  it('tests the unsaved draft against `testConnection.route`, never an `actions[]` entry', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
          testConnection: { route: '/test-connection' },
          // A row action happens to share the id 'test' here — proves the test handler
          // never falls back to reading actions[], the shape of the original bug.
          actions: [{ id: 'test', labelKey: 'x.stats', method: 'GET', route: '/providers/:id/stats', scope: 'row' }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush([]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);

    const run = fixture.componentInstance.providerTestConnection(fixture.componentInstance.providersView()!);
    const resultPromise = run!({ implementation: 'demo', settings: {} });
    const req = http.expectOne({ url: '/api/plugins/fliks.a/test-connection', method: 'POST' });
    expect(req.request.body).toEqual({ implementation: 'demo', settings: {} });
    req.flush({ ok: true, messageKey: 'ok' });
    expect(await resultPromise).toEqual({ ok: true, message: 'All good' });
    http.verify();
  });

  it('is absent (null) when a providers page declares no `testConnection`', () => {
    const { fixture } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
        }),
      },
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.providerTestConnection(fixture.componentInstance.providersView()!)).toBeNull();
  });

  it('falls back to a generic message, never the raw key, when `messageKey` resolves to nothing', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
          testConnection: { route: '/test-connection' },
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush([]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);

    const run = fixture.componentInstance.providerTestConnection(fixture.componentInstance.providersView()!);
    const resultPromise = run!({ implementation: 'demo', settings: {} });
    http
      .expectOne({ url: '/api/plugins/fliks.a/test-connection', method: 'POST' })
      .flush({ ok: false, messageKey: 'download.indexers.test.a_key_this_plugin_never_shipped', detail: 'boom' });
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('download.indexers.test.a_key_this_plugin_never_shipped');
    expect(result.message).toContain('boom');
    http.verify();
  });

  it('renders one button per `scope: \'row\'` entry — plural, unlike `actions[].find` first-wins', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
          actions: [
            {
              id: 'stats',
              labelKey: 'x.stats',
              method: 'GET',
              route: '/providers/:id/stats',
              scope: 'row',
              result: { kind: 'table', columns: [{ key: 'date', labelKey: 'x.date' }], emptyKey: 'x.empty' },
            },
            { id: 'clear-cooldown', labelKey: 'x.clear', method: 'DELETE', route: '/providers/:id/cooldown', scope: 'row' },
            { id: 'clear-all', labelKey: 'x.clear_all', method: 'DELETE', route: '/providers/cooldowns', scope: 'list' },
          ],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush([]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);

    const rowActions = fixture.componentInstance.providerRowActions(fixture.componentInstance.providersView()!);
    expect(rowActions.map((a) => a.labelKey)).toEqual(['x.stats', 'x.clear']);
    expect(rowActions[0]!.route).toBe('/api/plugins/fliks.a/providers/:id/stats');
    // Dropping `result` here would make the renderer hide the button entirely.
    expect(rowActions[0]!.result?.columns.map((c) => c.key)).toEqual(['date']);
    http.verify();
  });

  it('renders the table renderer with declared columns from the declared route', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'queue' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'table',
          id: 'x',
          labelKey: 'x.title',
          list: '/queue',
          columns: [{ key: 'name', labelKey: 'x.col_name' }],
          // Cast on purpose: a manifest is untrusted JSON, so an id outside the union is
          // exactly what this asserts core refuses to render.
          rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.unknown' as never }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'GET' }).flush([{ id: 1, name: 'Torrent A' }]);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Torrent A');
    // An actionId this generic host doesn't own resolves to nothing — no row button, no dead click.
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.some((b) => b.textContent?.includes('x.doit'))).toBe(false);
    http.verify();
  });

  it('VERDICT: a `table.open-media` row action renders a button and navigates using the row\'s mediaId/mediaType', async () => {
    const { fixture, http, navigateByUrl } = createComponent(
      { pluginId: 'fliks.a', view: 'queue' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'table',
          id: 'x',
          labelKey: 'x.title',
          list: '/queue',
          columns: [{ key: 'name', labelKey: 'x.col_name' }],
          rowActions: [{ kind: 'action', labelKey: 'x.open', actionId: 'table.open-media' }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'GET' }).flush([
      { id: 1, name: 'Show A', mediaId: 42, mediaType: 'series' },
    ]);
    await settle(fixture);

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const button = buttons.find((b) => b.textContent?.includes('x.open'));
    expect(button).toBeDefined();
    button!.click();
    expect(navigateByUrl).toHaveBeenCalledWith('/series/42');
    http.verify();
  });

  it('a table `proxy` row action hits the proxied route with its declared method; a `route` row action navigates in-app unprefixed', async () => {
    const { fixture, http, navigateByUrl } = createComponent(
      { pluginId: 'fliks.a', view: 'queue' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'table',
          id: 'x',
          labelKey: 'x.title',
          list: '/queue',
          columns: [{ key: 'name', labelKey: 'x.col_name' }],
          rowActions: [
            { kind: 'proxy', labelKey: 'x.remove', method: 'DELETE', path: '/queue/1' },
            { kind: 'route', labelKey: 'x.details', path: '/plugins/fliks.a/details' },
          ],
          listActions: [{ labelKey: 'x.clear', method: 'DELETE', path: '/queue' }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'GET' }).flush([{ id: 1, name: 'Torrent A' }]);
    await settle(fixture);

    // Checked first, before the row (and its buttons) is removed by the proxy delete below.
    const routeButtons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    routeButtons.find((b) => b.textContent?.includes('x.details'))!.click();
    // An in-app Angular route is never plugin-relative — it must reach the router verbatim.
    expect(navigateByUrl).toHaveBeenCalledWith('/plugins/fliks.a/details');

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    buttons.find((b) => b.textContent?.includes('x.remove'))!.click();
    http.expectOne({ url: '/api/plugins/fliks.a/queue/1', method: 'DELETE' }).flush({});
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'GET' }).flush([]);
    await settle(fixture);

    const clearButtons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    clearButtons.find((b) => b.textContent?.includes('x.clear'))!.click();
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'DELETE' }).flush({});
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/queue', method: 'GET' }).flush([]);
    await settle(fixture);
    http.verify();
  });

  it('renders a `scope: \'list\'` provider action once, outside the rows, and running it against its declared method reloads', async () => {
    const { fixture, http } = createComponent(
      { pluginId: 'fliks.a', view: 'providers' },
      {
        hasPlugin: () => true,
        configPage: () => ({
          kind: 'providers',
          id: 'x',
          labelKey: 'x.title',
          list: '/providers',
          implementations: '/implementations',
          actions: [{ id: 'sync', labelKey: 'x.sync_all', method: 'POST', route: '/sync', scope: 'list' }],
        }),
      },
    );
    fixture.detectChanges();
    http.expectOne({ url: '/api/plugins/fliks.a/implementations', method: 'GET' }).flush([]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const matches = buttons.filter((b) => b.textContent?.includes('x.sync_all'));
    expect(matches).toHaveLength(1);

    matches[0].click();
    http.expectOne({ url: '/api/plugins/fliks.a/sync', method: 'POST' }).flush({});
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.a/providers', method: 'GET' }).flush([]);
    await settle(fixture);
    http.verify();
  });
});
