import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PluginUiRegistryService } from './plugin-ui-registry.service';
import type { PluginUiEntry } from './plugin-ui-response';
import type { UiContribution } from './contribution.types';

const contribution = (id: string, weight: number, overrides: Partial<UiContribution> = {}): UiContribution => ({
  id,
  slot: 'nav.main',
  weight,
  labelKey: `x.${id}`,
  action: { kind: 'route', path: `/plugins/x/${id}` },
  ...overrides,
});

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
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
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

  it('returns null for releasePicker when no plugin declares one', async () => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [])]);
    await promise;

    expect(registry.releasePicker()).toBeNull();
  });

  it('returns the declaring plugin\'s id and routes for releasePicker', async () => {
    const routes = {
      movie: { search: '/:id/releases', grab: '/:id/grab' },
      season: { search: '/:id/seasons/:seasonId/releases', grab: '/:id/seasons/:seasonId/grab' },
      episode: { search: '/:id/episodes/:episodeId/releases', grab: '/:id/episodes/:episodeId/grab' },
    };
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([entry('fliks.a', [], { releasePicker: routes })]);
    await promise;

    expect(registry.releasePicker()).toEqual({ pluginId: 'fliks.a', routes });
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
});
