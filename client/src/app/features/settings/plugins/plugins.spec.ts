import { vi } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, TranslateService, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginsSettingsComponent } from './plugins';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import type { CatalogPluginEntry, PluginSourceRow, PluginSummary } from '../../../core/services/api/plugins-api.service';
import { statusDetail } from './plugin-status';
import { PluginsState } from './plugins-state';

/** Drives the page through its cards' actions and the real HTTP wire. */

async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

const ROW: PluginSummary = {
  pluginId: 'fliks.acme',
  name: 'Acme',
  version: '1.0.0',
  kind: 'data',
  origin: 'manual',
  status: 'active',
  statusReason: null,
  signature: 'unsigned',
  verifiedByKeyId: null,
  enabled: true,
  description: '',
  author: 'a',
  homepage: null,
  capabilities: [],
  descriptions: {},
};

const SOURCE: PluginSourceRow = {
  id: 1,
  url: 'https://example.com/catalog.json',
  enabled: true,
  hasPinnedKey: false,
  lastRefreshedAt: null,
  lastRefreshError: null,
  pluginCount: 1,
};

function offer(id: string, versions: string[]): CatalogPluginEntry {
  return {
    id,
    name: id,
    description: 'd',
    author: 'a',
    kind: 'data',
    installable: versions.map((version) => ({ version, pluginApi: 3, fliks: '*' })),
    hidden: null,
  };
}

// jsdom has no <dialog> methods nor ResizeObserver (the scroller rows).
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const confirmation = { confirm: () => Promise.resolve(true), confirmWithToggle: vi.fn() };
const saved: string[] = [];

/** The installed list, then the catalogue and the metrics it loads alongside. */
async function flushReload(
  fixture: ComponentFixture<unknown>,
  http: HttpTestingController,
  rows: PluginSummary[],
  offers: CatalogPluginEntry[] = [],
) {
  http.expectOne({ url: '/api/plugins', method: 'GET' }).flush(rows);
  await settle(fixture);
  for (const req of http.match({ url: '/api/plugins/sources', method: 'GET' })) req.flush(offers.length ? [SOURCE] : []);
  http.expectOne({ url: '/api/plugins/metrics', method: 'GET' }).flush([]);
  await settle(fixture);
  if (offers.length) {
    http.expectOne({ url: '/api/plugins/sources/1/catalog', method: 'GET' }).flush({
      cachedCatalog: { plugins: offers },
      lastRefreshedAt: null,
      lastRefreshError: null,
    });
    await settle(fixture);
  }
}

async function createComponent(rows: PluginSummary[] = [ROW], offers: CatalogPluginEntry[] = []) {
  confirmation.confirmWithToggle.mockResolvedValue({ ok: true, toggle: false });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ConfirmationService, useValue: confirmation },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(PluginsSettingsComponent);
  fixture.detectChanges();
  await flushReload(fixture, http, rows, offers);
  return { fixture, http, page: fixture.componentInstance, state: TestBed.inject(PluginsState) };
}

function action(page: PluginsSettingsComponent, id: string, key: string) {
  return page.actionsById().get(id)?.find((a) => a.labelKey === key || a.label === key);
}

function cardText(fixture: ComponentFixture<unknown>): string {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('app-media-card'))
    .map((c) => c.textContent)
    .join('|');
}

describe('PluginsSettingsComponent: enable/disable', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('disabling calls POST .../disable and the row signal reflects the response', async () => {
    const { fixture, http, page, state } = await createComponent();

    action(page, 'fliks.acme', 'settings.plugins.disable')!.run();
    await settle(fixture);

    // The server disagrees with the request, so only a real read of this response can pass.
    http.expectOne({ url: '/api/plugins/fliks.acme/disable', method: 'POST' }).flush({ ...ROW, enabled: true, statusReason: 'server-said-so' });
    await settle(fixture);
    // Contributions are re-read so the nav and the settings sidebar follow the switch.
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);

    expect(state.rows()[0]).toEqual(expect.objectContaining({ enabled: true, statusReason: 'server-said-so' }));
  });

  it('a disabled plugin offers enable, which calls POST .../enable', async () => {
    const { fixture, http, page, state } = await createComponent([{ ...ROW, enabled: false }]);
    expect(action(page, 'fliks.acme', 'settings.plugins.disable')).toBeUndefined();

    action(page, 'fliks.acme', 'settings.plugins.enable')!.run();
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.acme/enable', method: 'POST' }).flush(ROW);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);

    expect(state.rows()[0].enabled).toBe(true);
  });
});

describe('PluginsSettingsComponent: uninstall', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('VERDICT: uninstalling re-reads the contributions, so the sidebar loses the plugin at once', async () => {
    const { fixture, http, page, state } = await createComponent();

    action(page, 'fliks.acme', 'settings.plugins.uninstall')!.run();
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.acme', method: 'DELETE' }).flush({});
    await settle(fixture);
    await flushReload(fixture, http, []);

    // Without this the pages stay linked in the admin sidebar until a full page load.
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);
  });

  it('a process plugin shows its row counts and deletes its data only when the toggle is on', async () => {
    const proc: PluginSummary = { ...ROW, kind: 'process' };
    const { fixture, http, page, state } = await createComponent([proc]);
    confirmation.confirmWithToggle.mockResolvedValue({ ok: true, toggle: true });

    void state.uninstall(proc);
    http.expectOne({ url: '/api/plugins/fliks.acme/data-usage', method: 'GET' }).flush({ tables: [{ name: 'items', rows: 12 }] });
    await settle(fixture);

    http.expectOne({ url: '/api/plugins/fliks.acme?deleteData=true', method: 'DELETE' }).flush({});
    await settle(fixture);
    await flushReload(fixture, http, []);
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);
  });

  it('a bundled plugin cannot be uninstalled', async () => {
    const { page, state } = await createComponent([{ ...ROW, origin: 'bundled' }]);
    expect(action(page, 'fliks.acme', 'settings.plugins.uninstall')).toBeUndefined();
  });
});

describe('statusDetail', () => {
  it('the status detail joins the failure reason and the stderr tail', () => {
    const detail = statusDetail({ ...ROW, status: 'failed', statusReason: 'boom', statusMessage: 'bad hello token' });
    expect(detail).toContain('boom');
    expect(detail).toContain('bad hello token');
    expect(statusDetail({ ...ROW, statusMessage: '' })).toBeNull();
  });
});

describe('PluginsSettingsComponent: cards', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('VERDICT: a disabled plugin does not read as active on its card', async () => {
    const { fixture } = await createComponent([{ ...ROW, enabled: false }]);
    expect(cardText(fixture)).toContain('settings.plugins.status_disabled');
  });

  it('a plugin that is on but not answering reads as unavailable', async () => {
    const { fixture } = await createComponent([{ ...ROW, kind: 'process', processState: 'backoff' }]);
    expect(cardText(fixture)).toContain('settings.plugins.status_unavailable');
  });

  it('an active plugin shows its version alone', async () => {
    const { page, state } = await createComponent();
    expect(state.subtitleFor(state.installed()[0])).toBe('v1.0.0');
  });

  it('a newer catalog version shows on the card and offers the update', async () => {
    const { fixture, http, page, state } = await createComponent([ROW], [offer('fliks.acme', ['1.0.0', '1.1.0'])]);

    expect(state.installed()[0].updateTo).toBe('1.1.0');
    expect(cardText(fixture)).toContain('settings.plugins.update_badge');

    action(page, 'fliks.acme', 'settings.plugins.catalogue.switch_to')!.run();
    await settle(fixture);
    const req = http.expectOne({ url: '/api/plugins/sources/1/inspect', method: 'POST' });
    expect(req.request.body).toEqual({ pluginId: 'fliks.acme', version: '1.1.0' });
    req.flush({ installable: false, refusalCode: 'x' });
    await settle(fixture);
  });

  it('the newest version installed shows no update', async () => {
    const { fixture, page, state } = await createComponent([ROW], [offer('fliks.acme', ['1.0.0'])]);
    expect(state.installed()[0].updateTo).toBeNull();
    expect(cardText(fixture)).not.toContain('settings.plugins.update_badge');
  });

  it('a held update flags the card', async () => {
    const held = { version: '2.0.0', reason: 'new-scopes', detail: 'media:read' } as const;
    const { fixture } = await createComponent([{ ...ROW, heldUpdate: held }]);
    expect(cardText(fixture)).toContain('settings.plugins.update_badge');
  });

  it('groups installed plugins by what they may do, empty groups dropped', async () => {
    const { state } = await createComponent([
      { ...ROW, pluginId: 'p.meta', capabilities: ['namespace:x', 'provider:x:movie'] },
      { ...ROW, pluginId: 'p.dl', capabilities: ['provider:y:book', 'scope:ingest:write'] },
      { ...ROW, pluginId: 'p.misc', capabilities: ['scope:config:rw'] },
      { ...ROW, pluginId: 'p.meta2', capabilities: ['provider:z:album'] },
    ]);
    expect(state.categories().map((c) => [c.id, c.entries.map((e) => e.id)])).toEqual([
      ['metadata', ['p.meta', 'p.meta2']],
      ['download', ['p.dl']],
      ['other', ['p.misc']],
    ]);
  });

  it('a category the catalog declares wins; an unknown one falls back to the capabilities', async () => {
    const { state } = await createComponent(
      [
        { ...ROW, pluginId: 'p.notify', capabilities: ['scope:config:rw'] },
        { ...ROW, pluginId: 'p.meta', capabilities: ['provider:x:movie'] },
      ],
      [
        { ...offer('p.notify', ['1.0.0']), category: 'notifications' },
        { ...offer('p.meta', ['1.0.0']), category: 'whatever' },
      ],
    );
    expect(state.categories().map((c) => [c.id, c.entries.map((e) => e.id)])).toEqual([
      ['metadata', ['p.meta']],
      ['notifications', ['p.notify']],
    ]);
  });

  it('the description follows the UI language, else the manifest one', async () => {
    const { state } = await createComponent([{ ...ROW, description: 'Data', descriptions: { en: 'Data (en)', fr: 'Données' } }]);
    expect(state.descriptionFor(state.installed()[0])).toBe('Data (en)');
    TestBed.inject(TranslateService).use('de');
    expect(state.descriptionFor(state.installed()[0])).toBe('Data');
  });

  it('a catalog plugin not installed gets no card', async () => {
    const { page, state } = await createComponent([ROW], [offer('fliks.other', ['0.1.0'])]);
    expect(state.categories().flatMap((c) => c.entries.map((e) => e.id))).toEqual(['fliks.acme']);
    expect(page.actionsById().has('fliks.other')).toBe(false);
  });

  it('an older catalog version is no update', async () => {
    const { state } = await createComponent([{ ...ROW, version: '0.4.0' }], [offer('fliks.acme', ['0.3.3'])]);
    expect(state.installed()[0].updateTo).toBeNull();
  });

  it('the card links its detail page, which lists the same actions minus that link', async () => {
    const { page, state } = await createComponent();
    expect(action(page, 'fliks.acme', 'settings.plugins.details')?.route).toBe('/admin/settings/plugins/fliks.acme');
    const keys = state.actionsFor(state.installed()[0], () => undefined, false).map((a) => a.labelKey);
    expect(keys).not.toContain('settings.plugins.details');
    expect(keys).toContain('settings.plugins.uninstall');
  });
});

describe('PluginsSettingsComponent: refresh all sources', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('refreshes every enabled source, then reloads the catalogue', async () => {
    const { fixture, http, page, state } = await createComponent();

    void state.refreshAllSources();
    http
      .expectOne({ url: '/api/plugins/sources', method: 'GET' })
      .flush([SOURCE, { ...SOURCE, id: 2, url: 'https://off.example', enabled: false }]);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/sources/1/refresh', method: 'POST' }).flush({ ok: true });
    http.expectNone({ url: '/api/plugins/sources/2/refresh', method: 'POST' });
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([]);
    await settle(fixture);
    expect(state.refreshing()).toBe(false);
  });
});

describe('PluginsSettingsComponent: export', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it.each([
    [false, '/api/plugins/fliks.acme/export'],
    [true, '/api/plugins/fliks.acme/export?includeSecrets=true'],
  ])('include secrets %s asks for %s', async (flag, url) => {
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    const { fixture, http, page, state } = await createComponent();
    confirmation.confirmWithToggle.mockResolvedValue({ ok: true, toggle: flag });

    void state.exportData(ROW);
    await settle(fixture);
    http.expectOne((r) => r.urlWithParams === url && r.method === 'GET').flush(new Blob(['{}']));
    await settle(fixture);

    expect(saved).toContain('fliks.acme.export.json');
  });
});
