import type { UiContribution } from '@fliks/plugin-contract/ui';

// `WhenPredicate` (mirrored from the backend contract) only lists the
// positive spellings; the evaluator's documented "!" negation isn't part of
// the type. Cast at the two call sites rather than fork the shared type.
type When = NonNullable<UiContribution['when']>;
const not = (p: string) => `!${p}` as unknown as When[number];

/**
 * Core's own `nav.main` / `nav.acquisition` items, expressed as contributions
 * so they merge with plugin contributions through the same weight/id sort
 * instead of being hardcoded markup. Weight 200 in `nav.acquisition` is free
 * for a plugin to claim; core has nothing of its own to put there.
 */
export const CORE_NAV_CONTRIBUTIONS: readonly UiContribution[] = [
  { id: 'core.home', slot: 'nav.main', weight: 100, labelKey: 'nav.home', icon: 'home', action: { kind: 'route', path: '/' } },
  { id: 'core.search', slot: 'nav.main', weight: 200, labelKey: 'search.title', icon: 'search', action: { kind: 'route', path: '/search' } },
  { id: 'core.my_profile', slot: 'nav.main', weight: 300, labelKey: 'nav.my_profile', icon: 'user-round', when: [not('isTv')], action: { kind: 'action', actionId: 'nav.my-profile' } },
  { id: 'core.playlists', slot: 'nav.main', weight: 2000, labelKey: 'nav.playlists', icon: 'list-video', action: { kind: 'route', path: '/playlists' } },
  { id: 'core.downloads', slot: 'nav.main', weight: 2100, labelKey: 'downloads.title', shortLabelKey: 'nav.downloads', icon: 'download', when: [not('isTv')], action: { kind: 'route', path: '/downloads' } },
  { id: 'core.history', slot: 'nav.main', weight: 2200, labelKey: 'nav.history', icon: 'history', action: { kind: 'route', path: '/history' } },

  { id: 'core.requests', slot: 'nav.acquisition', weight: 100, labelKey: 'nav.requests', icon: 'clipboard-list', badge: 'pendingRequests', tone: 'danger', action: { kind: 'route', path: '/requests' } },
  { id: 'core.calendar', slot: 'nav.acquisition', weight: 300, labelKey: 'nav.calendar', icon: 'calendar', action: { kind: 'route', path: '/calendar' } },
];

/** Libraries render as their own data-driven block, anchored between the
 *  weight-300 and weight-2000 core items — this is where a plugin's
 *  `nav.main` item at weight 1000-1999 would land, visually after them. */
export const LIBRARIES_BLOCK_WEIGHT = 1000;

/** One `menu-title` group in the admin settings sidebar. */
export interface CoreSettingsSection {
  labelKey: string;
  items: readonly UiContribution[];
}

/**
 * Core's own admin settings links as `settings.page` contributions, grouped
 * into the 7 sections the sidebar has always had. A plugin never joins one
 * of these — it gets a section of its own instead (see the admin feature's
 * `SettingsSectionsService`) — so weight only orders core items against
 * each other; the 100-spacing is kept anyway for a future core item to slot
 * into, on the same convention as `CORE_NAV_CONTRIBUTIONS`.
 */
export const CORE_SETTINGS_SECTIONS: readonly CoreSettingsSection[] = [
  {
    labelKey: 'admin.section_system',
    items: [
      { id: 'core.statistics', slot: 'settings.page', weight: 100, labelKey: 'nav.statistics', icon: 'bar-chart-3', action: { kind: 'route', path: '/admin/statistics' } },
      { id: 'core.system', slot: 'settings.page', weight: 200, labelKey: 'nav.system', icon: 'layout-grid', action: { kind: 'route', path: '/admin/system' } },
      { id: 'core.streams', slot: 'settings.page', weight: 300, labelKey: 'system.tab_streams', icon: 'play', action: { kind: 'route', path: '/admin/streams' } },
    ],
  },
  {
    labelKey: 'admin.section_settings',
    items: [
      { id: 'core.general', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.general', action: { kind: 'route', path: '/admin/settings/general' } },
      { id: 'core.libraries', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.libraries', action: { kind: 'route', path: '/admin/settings/libraries' } },
      { id: 'core.naming', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.naming', action: { kind: 'route', path: '/admin/settings/naming' } },
    ],
  },
  {
    labelKey: 'admin.section_media',
    items: [
      { id: 'core.quality_profiles', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.quality_profiles', action: { kind: 'route', path: '/admin/settings/quality-profiles' } },
      { id: 'core.language_profiles', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.language_profiles', action: { kind: 'route', path: '/admin/settings/language-profiles' } },
      { id: 'core.quality_definitions', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.quality_definitions', action: { kind: 'route', path: '/admin/settings/quality-definitions' } },
      { id: 'core.custom_formats', slot: 'settings.page', weight: 400, labelKey: 'settings.nav.custom_formats', action: { kind: 'route', path: '/admin/settings/custom-formats' } },
    ],
  },
  {
    labelKey: 'admin.section_subtitles',
    items: [
      { id: 'core.subtitles', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.subtitles', action: { kind: 'route', path: '/admin/settings/subtitles' } },
      { id: 'core.subtitle_providers', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.subtitle_providers', action: { kind: 'route', path: '/admin/settings/subtitle-providers' } },
      { id: 'core.subtitles_activity', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.subtitles_activity', action: { kind: 'route', path: '/admin/settings/subtitles-activity' } },
    ],
  },
  {
    labelKey: 'admin.section_integrations',
    items: [
      { id: 'core.media_servers', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.media_servers', action: { kind: 'route', path: '/admin/settings/media-servers' } },
      { id: 'core.data_imports', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.data_imports', action: { kind: 'route', path: '/admin/settings/data-imports' } },
      { id: 'core.notifications', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.notifications', action: { kind: 'route', path: '/admin/settings/notifications' } },
    ],
  },
  {
    labelKey: 'admin.section_users',
    items: [
      { id: 'core.users', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.users', action: { kind: 'route', path: '/admin/settings/users' } },
      { id: 'core.roles', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.roles', action: { kind: 'route', path: '/admin/settings/roles' } },
      { id: 'core.auto_approval', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.auto_approval', action: { kind: 'route', path: '/admin/settings/auto-approval' } },
    ],
  },
  {
    labelKey: 'admin.section_advanced',
    items: [
      { id: 'core.schedulers', slot: 'settings.page', weight: 100, labelKey: 'settings.nav.schedulers', action: { kind: 'route', path: '/admin/settings/schedulers' } },
      { id: 'core.streaming', slot: 'settings.page', weight: 200, labelKey: 'settings.nav.streaming', action: { kind: 'route', path: '/admin/settings/streaming' } },
      { id: 'core.plugins', slot: 'settings.page', weight: 300, labelKey: 'settings.nav.plugins', action: { kind: 'route', path: '/admin/settings/plugins' } },
    ],
  },
];
