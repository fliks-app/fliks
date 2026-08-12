import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { AdminShellComponent } from './admin-shell';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { PluginUiEntry } from '../../core/plugin-ui/plugin-ui-response';
import type { UiContribution } from '../../core/plugin-ui/contribution.types';

// Characterisation contract: this is the exact section/link shape the
// hand-written template rendered before the registry-driven refactor.
// Captured green against the untouched template, then re-run unchanged
// against the refactor — see the task report for both runs.
const BASELINE_SIDEBAR = [
  { label: 'admin.section_system', links: [
    { label: 'nav.statistics', href: '/admin/statistics' },
    { label: 'nav.system', href: '/admin/system' },
    { label: 'system.tab_streams', href: '/admin/streams' },
  ] },
  { label: 'admin.section_settings', links: [
    { label: 'settings.nav.general', href: '/admin/settings/general' },
    { label: 'settings.nav.libraries', href: '/admin/settings/libraries' },
    { label: 'settings.nav.naming', href: '/admin/settings/naming' },
  ] },
  { label: 'admin.section_media', links: [
    { label: 'settings.nav.quality_profiles', href: '/admin/settings/quality-profiles' },
    { label: 'settings.nav.language_profiles', href: '/admin/settings/language-profiles' },
    { label: 'settings.nav.quality_definitions', href: '/admin/settings/quality-definitions' },
    { label: 'settings.nav.custom_formats', href: '/admin/settings/custom-formats' },
    { label: 'settings.nav.delay_profiles', href: '/admin/settings/delay-profiles' },
  ] },
  { label: 'admin.section_subtitles', links: [
    { label: 'settings.nav.subtitles', href: '/admin/settings/subtitles' },
    { label: 'settings.nav.subtitle_providers', href: '/admin/settings/subtitle-providers' },
    { label: 'settings.nav.subtitles_activity', href: '/admin/settings/subtitles-activity' },
  ] },
  { label: 'admin.section_integrations', links: [
    { label: 'settings.nav.media_servers', href: '/admin/settings/media-servers' },
    { label: 'settings.nav.data_imports', href: '/admin/settings/data-imports' },
    { label: 'settings.nav.notifications', href: '/admin/settings/notifications' },
  ] },
  { label: 'admin.section_users', links: [
    { label: 'settings.nav.users', href: '/admin/settings/users' },
    { label: 'settings.nav.roles', href: '/admin/settings/roles' },
    { label: 'settings.nav.auto_approval', href: '/admin/settings/auto-approval' },
  ] },
  { label: 'admin.section_advanced', links: [
    { label: 'settings.nav.schedulers', href: '/admin/settings/schedulers' },
    { label: 'settings.nav.streaming', href: '/admin/settings/streaming' },
    { label: 'settings.nav.plugins', href: '/admin/settings/plugins' },
  ] },
];

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

function readSidebar(fixture: ComponentFixture<AdminShellComponent>) {
  const menu: Element = fixture.nativeElement.querySelector('ul.menu');
  const sections: { label: string; links: { label: string; href: string }[] }[] = [];
  let current: { label: string; links: { label: string; href: string }[] } | null = null;
  for (const li of Array.from(menu.children)) {
    if (li.classList.contains('menu-title')) {
      current = { label: (li.textContent ?? '').replace(/\s+/g, ' ').trim(), links: [] };
      sections.push(current);
    } else if (current) {
      const a = li.querySelector('a');
      if (a) {
        current.links.push({
          label: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
          href: a.getAttribute('href') ?? '',
        });
      }
    }
  }
  return sections;
}

function createFixture(opts: { isAdmin?: boolean; entries?: PluginUiEntry[] } = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: Title, useValue: { setTitle: () => {} } },
      {
        provide: AuthService,
        useValue: { user: () => ({ id: 1, isAdmin: !!opts.isAdmin }), hasPermission: () => false },
      },
      { provide: TvService, useValue: { isTv: () => false, isAndroidTv: () => false } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      {
        provide: PluginUiRegistryService,
        useValue: { pluginEntries: () => opts.entries ?? [] },
      },
    ],
  });
  const fixture = TestBed.createComponent(AdminShellComponent);
  fixture.detectChanges();
  return fixture;
}

describe('AdminShellComponent — sidebar characterisation', () => {
  // Same fixture run under both an admin and a non-admin auth context: the
  // sidebar has never gated any of its 23 links on isAdmin (only the /admin
  // route guard does), and the refactor must not start doing so implicitly.
  it.each([['admin', true], ['non-admin', false]] as const)(
    'renders the unchanged 7-section, 23-link sidebar for a %s context',
    (_label, isAdmin) => {
      const fixture = createFixture({ isAdmin });
      expect(readSidebar(fixture)).toEqual(BASELINE_SIDEBAR);
    },
  );

  it('appends a plugin section after every core section, labelled by manifest name', () => {
    const fixture = createFixture({
      entries: [
        entry('fliks.b', [contribution('page', 100, { labelKey: 'b.page' })], { name: 'B Plugin' }),
      ],
    });
    const sections = readSidebar(fixture);
    expect(sections).toHaveLength(8);
    expect(sections[7]).toEqual({ label: 'B Plugin', links: [{ label: 'b.page', href: '/admin/settings/plugins/x/page' }] });
  });

  it('orders plugin sections by plugin id, not install/array order', () => {
    const fixture = createFixture({
      entries: [
        entry('fliks.zeta', [contribution('z', 100)], { name: 'Zeta' }),
        entry('fliks.alpha', [contribution('a', 100)], { name: 'Alpha' }),
      ],
    });
    const sections = readSidebar(fixture);
    expect(sections.slice(7).map((s) => s.label)).toEqual(['Alpha', 'Zeta']);
  });

  it('produces no section for a plugin with zero settings.page contributions', () => {
    const fixture = createFixture({
      entries: [entry('fliks.empty', [contribution('nav-item', 100, { slot: 'nav.main' })], { name: 'Empty' })],
    });
    expect(readSidebar(fixture)).toHaveLength(7);
  });

  it('produces no section for a plugin whose only contribution is hidden by `when`', () => {
    const fixture = createFixture({
      entries: [entry('fliks.hidden', [contribution('gone', 100, { when: ['isAdmin'] })], { name: 'Hidden' })],
    });
    // isAdmin is false in this fixture's default context, so the predicate fails.
    expect(readSidebar(fixture)).toHaveLength(7);
  });

  it('falls back to the plugin id when the manifest name is not yet in the response', () => {
    const fixture = createFixture({
      entries: [entry('fliks.noname', [contribution('page', 100)])],
    });
    expect(readSidebar(fixture)[7].label).toBe('fliks.noname');
  });
});
