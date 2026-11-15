import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { PluginUiRegistryService } from './plugin-ui-registry.service';
import type { PluginUiEntry } from './plugin-ui-response';
import { SessionStoreService } from '../services/session-store.service';
import type { UiContribution } from '@fliks/plugin-ui';

const contribution = (id: string, weight: number, overrides: Partial<UiContribution> = {}): UiContribution => ({
  id,
  slot: 'nav.main',
  weight,
  labelKey: `x.${id}`,
  action: { kind: 'route', path: `/plugins/x/${id}` },
  ...overrides,
});

const lang = signal<string | null>(null);
let langChanges: Subject<{ lang: string }>;
// A fresh subject per test: a registry of an earlier TestBed must not hear the switches.
const translateStub = () => {
  langChanges = new Subject();
  return { provide: TranslateService, useValue: { currentLang: lang, fallbackLang: () => null, onLangChange: langChanges } };
};

const entry = (pluginId: string, contributions: UiContribution[], extra: Partial<PluginUiEntry> = {}): PluginUiEntry => ({
  pluginId,
  contributions,
  configPages: [],
  ...extra,
});

describe('PluginUiRegistryService', () => {
  let http: HttpTestingController;
  let registry: PluginUiRegistryService;

  beforeEach(() => {
    lang.set(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        translateStub(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    registry = TestBed.inject(PluginUiRegistryService);
  });

  afterEach(() => http.verify());

  it('boots to an empty registry before load() ever resolves', () => {
    expect(registry.contributionsFor('nav.main')).toEqual([]);
    expect(registry.hasPlugin('fliks.a')).toBe(false);
  });

  it('caches the response and never issues a second request', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [contribution('a', 100)])]);
    await promise;

    expect(registry.hasPlugin('fliks.a')).toBe(true);
    // A second read must not touch the network — HttpTestingController.verify()
    // in afterEach would fail if it did.
    expect(registry.contributionsFor('nav.main')).toHaveLength(1);
  });

  it('sorts contributions ascending by weight, then ascending by id on a tie, across plugins', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [contribution('z', 100), contribution('a', 100), contribution('b', -50)]),
      entry('fliks.b', [contribution('c', 50)]),
    ]);
    await promise;

    expect(registry.contributionsFor('nav.main').map((c) => c.id)).toEqual(['b', 'c', 'a', 'z']);
  });

  it('keeps slots separate', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [
        contribution('nav', 100, { slot: 'nav.main' }),
        contribution('act', 100, { slot: 'media.actions' }),
      ]),
    ]);
    await promise;

    expect(registry.contributionsFor('nav.main').map((c) => c.id)).toEqual(['nav']);
    expect(registry.contributionsFor('media.actions').map((c) => c.id)).toEqual(['act']);
  });

  it('fails open to an empty registry on an HTTP error — never throws, never hangs', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush('boom', { status: 500, statusText: 'Server Error' });
    await expect(promise).resolves.toBeUndefined();

    expect(registry.contributionsFor('nav.main')).toEqual([]);
    expect(registry.hasPlugin('fliks.a')).toBe(false);
  });

  it('fails open to an empty registry on a malformed (non-array) payload', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush({ not: 'an array' } as never);
    await expect(promise).resolves.toBeUndefined();

    expect(registry.contributionsFor('nav.main')).toEqual([]);
  });

  it('fails open to an empty registry when the request times out', async () => {
    vi.useFakeTimers();
    try {
      const promise = registry.load();
      http.expectOne('/api/plugins/ui'); // never flushed — simulates a hung plugin process
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(promise).resolves.toBeUndefined();
      expect(registry.contributionsFor('nav.main')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds a contribution by its route path, across every slot', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [contribution('settings', 100, { slot: 'settings.page', action: { kind: 'route', path: '/admin/settings/plugins/fliks.a/settings' } })]),
    ]);
    await promise;

    expect(registry.findRouteContribution('/admin/settings/plugins/fliks.a/settings')?.id).toBe('settings');
    expect(registry.findRouteContribution('/no/such/path')).toBeUndefined();
  });

  it('ignores an action-kind contribution when resolving by path', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [contribution('act', 100, { action: { kind: 'action', actionId: 'core.thing' } })]),
    ]);
    await promise;

    expect(registry.findRouteContribution('/plugins/x/act')).toBeUndefined();
  });

  it('resolves a config page by plugin id and page id', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [], { configPages: [{ id: 'main', labelKey: 'x.main', fields: [] }] }),
    ]);
    await promise;

    expect(registry.configPage('fliks.a', 'main')?.labelKey).toBe('x.main');
    expect(registry.configPage('fliks.a', 'missing')).toBeUndefined();
    expect(registry.configPage('fliks.unknown', 'main')).toBeUndefined();
  });

  it('merges every plugin i18n dict for a locale, and returns undefined when none ship it', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.a', [], { i18n: { fr: { 'fliks.a.title': 'Titre A' } } }),
      entry('fliks.b', [], { i18n: { fr: { 'fliks.b.title': 'Titre B' } } }),
    ]);
    await promise;

    expect(registry.i18nFor('fr')).toEqual({ 'fliks.a.title': 'Titre A', 'fliks.b.title': 'Titre B' });
    expect(registry.i18nFor('de')).toBeUndefined();
  });

  it('orders providers by acquisition.order, not array position, and filters by kind and level', async () => {
    const routes = (kind: string, level: string) => ({ byKind: { [kind]: { [level]: { search: '/s', grab: '/g' } } } });
    const provider = (id: string, order: number, kind: string, sources: string[]) =>
      entry(id, [], { acquisition: { order, routes: routes(kind, 'work'), sources: sources.map((k) => ({ id: k, name: k, kinds: [k] })) } });
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      provider('fliks.b', 1, 'movie', ['movie']),
      provider('fliks.a', 0, 'movie', ['movie']),
      provider('fliks.c', 2, 'movie', []),
      entry('fliks.plain', []),
    ]);
    await promise;

    expect(registry.providers().map((p) => p.pluginId)).toEqual(['fliks.a', 'fliks.b', 'fliks.c']);
    // fliks.c has no source: it serves nothing.
    expect(registry.providersFor('movie', 'work').map((p) => p.pluginId)).toEqual(['fliks.a', 'fliks.b']);
    expect(registry.providersFor('movie', 'item')).toEqual([]);
    expect(registry.providersFor('book', 'work')).toEqual([]);
  });

  it('keeps the known entries when a refresh fails, and replaces them when it succeeds', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [])]);
    await promise;

    const failed = registry.load(true);
    http.expectOne('/api/plugins/ui').flush(null, { status: 500, statusText: 'err' });
    await failed;
    expect(registry.hasPlugin('fliks.a')).toBe(true);

    const refreshed = registry.load(true);
    http.expectOne('/api/plugins/ui').flush([entry('fliks.b', [])]);
    await refreshed;
    expect(registry.hasPlugin('fliks.a')).toBe(false);
  });

  it('lets no plugin redefine another plugin\'s key, picking the winner by plugin id', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([
      entry('fliks.zeta', [], { i18n: { en: { shared: 'from zeta' } } }),
      entry('fliks.alpha', [], { i18n: { en: { shared: 'from alpha', own: 'a' } } }),
    ]);
    await promise;

    // Ordered by plugin id and first-declared wins, so install order cannot change it.
    expect(registry.i18nFor('en')).toEqual({ shared: 'from alpha', own: 'a' });
  });

  it('asks for the active language and fetches again only when it changes', async () => {
    lang.set('fr');
    const first = registry.load();
    http.expectOne('/api/plugins/ui?lang=fr').flush([entry('fliks.a', [], { i18n: { fr: { 'a.x': 'X' } } })]);
    await first;

    langChanges.next({ lang: 'fr' });
    lang.set('de');
    langChanges.next({ lang: 'de' });
    http.expectOne('/api/plugins/ui?lang=de').flush([entry('fliks.a', [], { i18n: { de: { 'a.x': 'Y' } } })]);
    await new Promise((resolve) => setTimeout(resolve));
    expect(registry.i18nFor('de')).toEqual({ 'a.x': 'Y' });
  });

  it('drops the answer of a language switched away from during the request', async () => {
    lang.set('fr');
    const stale = registry.load();
    const fr = http.expectOne('/api/plugins/ui?lang=fr');
    lang.set('de');
    langChanges.next({ lang: 'de' });
    http.expectOne('/api/plugins/ui?lang=de').flush([entry('fliks.de', [])]);
    fr.flush([entry('fliks.fr', [])]);
    await stale;
    await new Promise((resolve) => setTimeout(resolve));
    expect(registry.hasPlugin('fliks.de')).toBe(true);
    expect(registry.hasPlugin('fliks.fr')).toBe(false);
  });
});

describe('PluginUiRegistryService boot', () => {
  let http: HttpTestingController;
  let registry: PluginUiRegistryService;

  beforeEach(() => {
    localStorage.clear();
    lang.set(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        translateStub(),
        { provide: SessionStoreService, useValue: { active: () => ({ user: { id: 7 } }) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    registry = TestBed.inject(PluginUiRegistryService);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('waits on the network with nothing stored, then serves the stored registry at once and revalidates it', async () => {
    const first = registry.boot();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [contribution('a', 100)])]);
    await first;

    const next = TestBed.runInInjectionContext(() => new PluginUiRegistryService());
    await next.boot();
    expect(next.hasPlugin('fliks.a')).toBe(true);

    http.expectOne('/api/plugins/ui').flush([entry('fliks.b', [contribution('b', 100)])]);
    await new Promise((resolve) => setTimeout(resolve));
    expect(next.hasPlugin('fliks.b')).toBe(true);
    expect(next.hasPlugin('fliks.a')).toBe(false);
  });

  it('stores the registry per language, so another language waits on the network', async () => {
    lang.set('fr');
    const first = registry.boot();
    http.expectOne('/api/plugins/ui?lang=fr').flush([entry('fliks.a', [contribution('a', 100)])]);
    await first;

    lang.set('de');
    const next = TestBed.runInInjectionContext(() => new PluginUiRegistryService());
    const booted = next.boot();
    expect(next.hasPlugin('fliks.a')).toBe(false);
    http.expectOne('/api/plugins/ui?lang=de').flush([entry('fliks.b', [contribution('b', 100)])]);
    await booted;
    expect(next.hasPlugin('fliks.b')).toBe(true);
  });

  it('keeps the stored registry when the revalidation fails', async () => {
    const first = registry.boot();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [contribution('a', 100)])]);
    await first;

    const next = TestBed.runInInjectionContext(() => new PluginUiRegistryService());
    await next.boot();
    http.expectOne('/api/plugins/ui').flush('down', { status: 503, statusText: 'Unavailable' });
    await new Promise((resolve) => setTimeout(resolve));
    expect(next.hasPlugin('fliks.a')).toBe(true);
  });
});
