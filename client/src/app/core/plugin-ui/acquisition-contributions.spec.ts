import type { UiContribution } from '@fliks/plugin-ui';
import { withCoreAcquisition } from './acquisition-contributions';
import type { WhenContext } from './when-evaluator';

const ctx = (over: Partial<WhenContext> = {}): WhenContext => ({
  isAdmin: false,
  hasPermission: () => true,
  hasQualityProfile: true,
  hasAcquisitionProvider: true,
  isTv: false,
  isTouch: false,
  ...over,
});

const legacy: UiContribution = {
  id: 'fliks.acme.search',
  slot: 'media.actions',
  weight: 600,
  labelKey: 'x.search',
  action: { kind: 'action', actionId: 'media.search-releases' },
};
const other: UiContribution = { ...legacy, id: 'fliks.acme.other', action: { kind: 'action', actionId: 'media.open' } };
const ids = (l: UiContribution[]) => l.map((c) => c.id);

describe('withCoreAcquisition', () => {
  it('offers the core Files submenu when a provider serves the title and drops the plugin duplicate', () => {
    const rows = withCoreAcquisition('work', ctx(), [legacy, other]);
    expect(ids(rows)).toEqual(['core.files_group_work', 'fliks.acme.other']);
    expect(rows[0].action.kind).toBe('submenu');
    expect(ids(rows[0].children!)).toEqual(['core.search_releases_work', 'core.grab_best_work']);
  });

  it('uses the group and item action ids at those levels', () => {
    const actions = (level: 'group' | 'item') =>
      withCoreAcquisition(level, ctx(), [])[0].children!.map((c) => (c.action.kind === 'action' ? c.action.actionId : ''));
    expect(actions('group')).toEqual(['group.search-releases', 'group.grab-best']);
    expect(actions('item')).toEqual(['item.search-releases', 'item.grab-best']);
  });

  it.each([
    ['no provider source', { hasAcquisitionProvider: false }],
    ['no quality profile', { hasQualityProfile: false }],
    ['no grab permission', { hasPermission: () => false }],
  ])('shows no core row with %s, leaving the plugin row as it is', (_name, over) => {
    const rows = withCoreAcquisition('work', ctx(over), [legacy]);
    expect(ids(rows)).toEqual(['core.files_group_work', 'fliks.acme.search']);
    expect(rows[0].children).toEqual([]);
  });

  it('keeps the tracking child of a monitored target even without a provider', () => {
    const rows = withCoreAcquisition('work', ctx({ hasAcquisitionProvider: false, isMonitored: true }), [legacy]);
    expect(ids(rows)).toEqual(['core.files_group_work', 'fliks.acme.search']);
    expect(ids(rows[0].children!)).toEqual(['core.tracking_work']);
  });

  it('shows no tracking child for an album, which the server does not track', () => {
    const rows = withCoreAcquisition('work', ctx({ isMonitored: true, mediaType: 'album' }), []);
    expect(ids(rows[0].children!)).toEqual(['core.search_releases_work', 'core.grab_best_work']);
  });
});
