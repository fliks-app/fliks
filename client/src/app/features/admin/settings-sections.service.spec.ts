import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SettingsSectionsService } from './settings-sections.service';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { PluginUiEntry } from '../../core/plugin-ui/plugin-ui-response';
import type { UiContribution } from '@fliks/plugin-contract/ui';

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

function createService(opts: { isAdmin?: boolean; entries?: PluginUiEntry[] } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: AuthService,
        useValue: { user: () => ({ id: 1, isAdmin: !!opts.isAdmin }), hasPermission: () => false },
      },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      { provide: PluginUiRegistryService, useValue: { pluginEntries: () => opts.entries ?? [] } },
    ],
  });
  return TestBed.inject(SettingsSectionsService);
}

describe('SettingsSectionsService', () => {
  it('resolves the 7 core sections with 23 items total, and nothing else, with an empty registry', () => {
    const svc = createService();
    const sections = svc.sections();
    expect(sections).toHaveLength(7);
    expect(sections.reduce((n, s) => n + s.items.length, 0)).toBe(23);
  });

  it('sorts a plugin section\'s own items by weight then id, independent of core', () => {
    const svc = createService({
      entries: [entry('fliks.a', [contribution('z', 100), contribution('a', 100), contribution('b', 50)], { name: 'A' })],
    });
    const plugin = svc.sections().at(-1)!;
    expect(plugin.items.map((i) => i.id)).toEqual(['b', 'a', 'z']);
  });

  it('never lets a plugin contribution join a core section, however its id or weight looks', () => {
    const svc = createService({
      // Deliberately mimics a core id/weight to prove grouping is by plugin
      // entry, never by string-matching an item into an existing section.
      entries: [entry('fliks.a', [contribution('core.system', 50)], { name: 'A' })],
    });
    const sections = svc.sections();
    const system = sections.find((s) => s.id === 'core:admin.section_system')!;
    expect(system.items).toHaveLength(3); // its 3 real core items only, not 4
    expect(sections.at(-1)!.items.map((i) => i.id)).toEqual(['core.system']);
  });

  it('ignores a plugin contribution outside settings.page when building its section', () => {
    const svc = createService({
      entries: [entry('fliks.a', [contribution('nav', 100, { slot: 'nav.main' })], { name: 'A' })],
    });
    expect(svc.sections()).toHaveLength(7);
  });

  it('drops a plugin settings.page contribution with an unrecognised action kind', () => {
    const svc = createService({
      entries: [entry('fliks.a', [contribution('broken', 100, { action: { kind: 'bogus' } as never })], { name: 'A' })],
    });
    expect(svc.sections()).toHaveLength(7);
  });

  it('produces the identical section list for an admin and a non-admin context', () => {
    const withAdmin = createService({ isAdmin: true }).sections();
    const withoutAdmin = createService({ isAdmin: false }).sections();
    expect(withoutAdmin).toEqual(withAdmin);
  });
});
