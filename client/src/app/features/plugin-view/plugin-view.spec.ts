import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PluginViewComponent } from './plugin-view';
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
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap(params)) } },
      { provide: Router, useValue: { navigateByUrl } },
      { provide: PluginUiRegistryService, useValue: registry },
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

  it('runs a `scope: \'row\'` provider action with its declared method against the proxied route', async () => {
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
          actions: [{ id: 'test', labelKey: 'x.test', method: 'DELETE', route: '/providers/reset', scope: 'row' }],
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
    // A method other than POST proves `action.method` drives the call, not a hardcoded verb.
    http.expectOne({ url: '/api/plugins/fliks.a/providers/reset', method: 'DELETE' }).flush({ ok: true, message: 'ok' });
    expect(await resultPromise).toEqual({ ok: true, message: 'ok' });
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
          rowActions: [{ kind: 'action', labelKey: 'x.doit', actionId: 'core.unknown' }],
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
