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
  it('offers core rows when a provider serves the title and drops the plugin duplicate', () => {
    expect(ids(withCoreAcquisition('work', ctx(), [legacy, other]))).toEqual([
      'core.grab_best_work',
      'core.search_releases_work',
      'fliks.acme.other',
    ]);
  });

  it('uses the group and item action ids at those levels', () => {
    const actions = (level: 'group' | 'item') =>
      withCoreAcquisition(level, ctx(), []).map((c) => (c.action.kind === 'action' ? c.action.actionId : ''));
    expect(actions('group')).toEqual(['group.grab-best', 'group.search-releases']);
    expect(actions('item')).toEqual(['item.grab-best', 'item.search-releases']);
  });

  it.each([
    ['no provider source', { hasAcquisitionProvider: false }],
    ['no quality profile', { hasQualityProfile: false }],
    ['no grab permission', { hasPermission: () => false }],
  ])('shows no core row with %s, leaving the plugin row as it is', (_name, over) => {
    expect(ids(withCoreAcquisition('work', ctx(over), [legacy]))).toEqual(['fliks.acme.search']);
  });
});
