import type { UiContribution } from './contribution.types';

// `WhenPredicate` (mirrored from the backend contract) only lists the
// positive spellings; the evaluator's documented "!" negation isn't part of
// the type. Cast at the two call sites rather than fork the shared type.
type When = NonNullable<UiContribution['when']>;
const not = (p: string) => `!${p}` as unknown as When[number];

/**
 * Core's own `nav.main` / `nav.acquisition` items, expressed as contributions
 * so they merge with plugin contributions through the same weight/id sort
 * instead of being hardcoded markup. `core.activity` sits at weight 200 —
 * reserved for an acquisition plugin per the plan — because no such plugin
 * ships yet; core keeps rendering the item it still owns today.
 */
export const CORE_NAV_CONTRIBUTIONS: readonly UiContribution[] = [
  { id: 'core.home', slot: 'nav.main', weight: 100, labelKey: 'nav.home', icon: 'home', action: { kind: 'route', path: '/' } },
  { id: 'core.search', slot: 'nav.main', weight: 200, labelKey: 'search.title', icon: 'search', action: { kind: 'route', path: '/search' } },
  { id: 'core.my_profile', slot: 'nav.main', weight: 300, labelKey: 'nav.my_profile', icon: 'user-round', when: [not('isTv')], action: { kind: 'action', actionId: 'nav.my-profile' } },
  { id: 'core.playlists', slot: 'nav.main', weight: 2000, labelKey: 'nav.playlists', icon: 'list-video', action: { kind: 'route', path: '/playlists' } },
  { id: 'core.downloads', slot: 'nav.main', weight: 2100, labelKey: 'downloads.title', shortLabelKey: 'nav.downloads', icon: 'download', when: [not('isTv')], action: { kind: 'route', path: '/downloads' } },
  { id: 'core.history', slot: 'nav.main', weight: 2200, labelKey: 'nav.history', icon: 'history', action: { kind: 'route', path: '/history' } },

  { id: 'core.requests', slot: 'nav.acquisition', weight: 100, labelKey: 'nav.requests', icon: 'clipboard-list', badge: 'pendingRequests', tone: 'danger', action: { kind: 'route', path: '/requests' } },
  { id: 'core.activity', slot: 'nav.acquisition', weight: 200, labelKey: 'nav.activity', icon: 'download', badge: 'queueActive', action: { kind: 'route', path: '/activity' } },
  { id: 'core.calendar', slot: 'nav.acquisition', weight: 300, labelKey: 'nav.calendar', icon: 'calendar', action: { kind: 'route', path: '/calendar' } },
];

/** Libraries render as their own data-driven block, anchored between the
 *  weight-300 and weight-2000 core items — this is where a plugin's
 *  `nav.main` item at weight 1000-1999 would land, visually after them. */
export const LIBRARIES_BLOCK_WEIGHT = 1000;
