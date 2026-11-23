import { provideZonelessChangeDetection } from '@angular/core';
import { ServerVersionService } from '../../core/services/server-version.service';
import { TestBed } from '@angular/core/testing';
import { SettingsSectionsService } from './settings-sections.service';
import { activeNavItem } from '../../shared/components/settings-drawer/settings-drawer';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { PluginUiEntry } from '../../core/plugin-ui/plugin-ui-response';
import type { UiContribution } from '@fliks/plugin-ui';

const contribution = (id: string, weight: number, overrides: Partial<UiContribution> = {}): UiContribution => ({
  id,
  slot: 'settings.page',
  weight,
  labelKey: `x.${id}`,
  action: { kind: 'route', path: `/admin/settings/plugins/x/${id}` },
  ...overrides,
});

const entry = (pluginId: string, contributions: UiContribution[], extra: Partial<PluginUiEntry> = {}): PluginUiEntry => ({
  pluginId,
  contributions,
  configPages: [],
  ...extra,
});

/** Every permission a core settings entry gates on today. */
const ALL_PERMISSIONS = ['users.manage', 'roles.manage', 'media.read'];

function createService(opts: { isAdmin?: boolean; permissions?: string[]; entries?: PluginUiEntry[] } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: AuthService,
        useValue: {
          user: () => ({ id: 1, isAdmin: !!opts.isAdmin }),
          // Mirrors the real service: an admin holds every permission.
          hasPermission: (p: string) => !!opts.isAdmin || (opts.permissions ?? []).includes(p),
        },
      },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      { provide: ServerVersionService, useValue: { supports: () => true } },
      { provide: PluginUiRegistryService, useValue: { pluginEntries: () => opts.entries ?? [] } },
    ],
  });
  return TestBed.inject(SettingsSectionsService);
}

describe('SettingsSectionsService', () => {
  it('resolves the 9 core sections with 35 items total, and nothing else, with an empty registry', () => {
    const svc = createService({ permissions: ALL_PERMISSIONS });
    const sections = svc.sections();
    expect(sections).toHaveLength(9);
    expect(sections.reduce((n, s) => n + s.items.length, 0)).toBe(35);
  });

  it('drops the core entries whose own pages the viewer has no permission for', () => {
    const ids = createService().sections().flatMap((s) => s.items.map((i) => i.id));
    expect(ids).not.toContain('core.users');
    expect(ids).not.toContain('core.roles');
    expect(ids).not.toContain('core.subtitles_activity');
    // Its own endpoints are Settings-gated, so it stays: the rule follows the policy, not the section.
    expect(ids).toContain('core.auto_approval');
    expect(ids).toContain('core.cleanup');
  });

  it('gives a metadata provider plugin no section', () => {
    const svc = createService({
      permissions: ALL_PERMISSIONS,
      entries: [entry('fliks.p', [contribution('cfg', 100)], { provider: { namespaces: ['p'], kinds: ['book'] } })],
    });
    expect(svc.sections().map((s) => s.id)).not.toContain('plugin:fliks.p');
  });

  it('sorts a plugin section\'s own items by weight then id, independent of core', () => {
    const svc = createService({
      permissions: ALL_PERMISSIONS,
      entries: [entry('fliks.a', [contribution('z', 100), contribution('a', 100), contribution('b', 50)], { name: 'A' })],
    });
    const plugin = svc.sections().at(-1)!;
    expect(plugin.items.map((i) => i.id)).toEqual(['b', 'a', 'z']);
  });

  it('never lets a plugin contribution join a core section, however its id or weight looks', () => {
    const svc = createService({
      permissions: ALL_PERMISSIONS,
      // Deliberately mimics a core id/weight to prove grouping is by plugin
      // entry, never by string-matching an item into an existing section.
      entries: [entry('fliks.a', [contribution('core.system', 50)], { name: 'A' })],
    });
    const sections = svc.sections();
    const system = sections.find((s) => s.id === 'core:admin.section_system')!;
    expect(system.items).toHaveLength(5); // its 5 real core items only, not 5
    expect(sections.at(-1)!.items.map((i) => i.id)).toEqual(['core.system']);
  });

  it('ignores a plugin contribution outside settings.page when building its section', () => {
    const svc = createService({
      permissions: ALL_PERMISSIONS,
      entries: [entry('fliks.a', [contribution('nav', 100, { slot: 'nav.main' })], { name: 'A' })],
    });
    expect(svc.sections()).toHaveLength(9);
  });

  it('drops a plugin settings.page contribution with an unrecognised action kind', () => {
    const svc = createService({
      permissions: ALL_PERMISSIONS,
      entries: [entry('fliks.a', [contribution('broken', 100, { action: { kind: 'bogus' } as never })], { name: 'A' })],
    });
    expect(svc.sections()).toHaveLength(9);
  });

  it('gives an admin the same sections as a non-admin holding the same permissions, plus Single sign-on', () => {
    const ids = (s: ReturnType<ReturnType<typeof createService>['sections']>) => s.flatMap((x) => x.items.map((i) => i.id));
    const withAdmin = ids(createService({ isAdmin: true }).sections());
    const withoutAdmin = ids(createService({ isAdmin: false, permissions: ALL_PERMISSIONS }).sections());
    expect(withAdmin.filter((id) => id !== 'core.sso')).toEqual(withoutAdmin);
    expect(withAdmin).toContain('core.sso');
    expect(withoutAdmin).not.toContain('core.sso');
  });
});

describe('activeNavItem over the admin sections: which entry the sidebar lights', () => {
  const lit = (url: string, entries: PluginUiEntry[] = []) =>
    activeNavItem(createService({ isAdmin: true, entries }).sections(), url)?.id ?? null;
  const pages = [
    contribution('general', 100),
    contribution('indexers', 110),
  ];

  it('lights the Plugins page on its own route', () => {
    expect(lit('/admin/settings/plugins')).toBe('core.plugins');
  });

  it("VERDICT: a plugin's own page lights that page, not the Plugins entry it sits under", () => {
    // The plugin page URL continues `/admin/settings/plugins`, so prefix matching lit both.
    expect(lit('/admin/settings/plugins/x/indexers', [entry('x', pages)])).toBe('indexers');
  });

  it('still lights a core entry from a deeper URL that no other entry claims', () => {
    expect(lit('/admin/settings/libraries/42')).toBe('core.libraries');
  });

  it('lights nothing on a URL no entry claims, rather than the closest prefix', () => {
    expect(lit('/admin/settings/pluginsomething')).toBeNull();
  });

  it('ignores a query string and a fragment', () => {
    expect(lit('/admin/settings/libraries?tab=2#top')).toBe('core.libraries');
  });
});
