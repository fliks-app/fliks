import type { UiContribution } from '@fliks/plugin-ui';
import type { AcquisitionLevel } from '../media-kinds';
import { evaluateWhen, type WhenContext } from './when-evaluator';

const PREFIX = { work: 'media', group: 'group', item: 'item' } as const;
const SLOT = { work: 'media.actions', group: 'media.group.actions', item: 'media.item.actions' } as const;

/** Core's release-picker rows of a level: shown once a provider has a source serving the kind at that level. */
function rowsOf(level: AcquisitionLevel): UiContribution[] {
  const when: UiContribution['when'] = ['hasPermission:media.grab', 'hasQualityProfile', 'hasAcquisitionProvider'];
  return [
    { id: 'core.grab_best', weight: 500, labelKey: 'media_detail.grab_best', icon: 'download', actionId: 'grab-best' },
    { id: 'core.search_releases', weight: 600, labelKey: 'media_detail.search_releases', icon: 'search', actionId: 'search-releases' },
  ].map(({ actionId, ...c }) => ({
    ...c,
    id: `${c.id}_${level}`,
    slot: SLOT[level],
    when,
    action: { kind: 'action', actionId: `${PREFIX[level]}.${actionId}` },
  }));
}

export const CORE_ACQUISITION_ACTIONS: Record<AcquisitionLevel, readonly UiContribution[]> = {
  work: rowsOf('work'),
  group: rowsOf('group'),
  item: rowsOf('item'),
};

/** Core's rows that pass `ctx`, plus the plugin ones minus any that offer the same action. A plugin row still shows (under its own `when`)
 *  where core's does not, which keeps a provider that has not published sources reachable. */
export function withCoreAcquisition(
  level: AcquisitionLevel,
  ctx: WhenContext,
  plugin: readonly UiContribution[],
): UiContribution[] {
  const core = CORE_ACQUISITION_ACTIONS[level].filter((c) => evaluateWhen(c.when, ctx));
  const owned = new Set(core.map((c) => (c.action.kind === 'action' ? c.action.actionId : '')));
  const keep = (c: UiContribution) => !(c.action.kind === 'action' && owned.has(c.action.actionId));
  return [...core, ...plugin.filter(keep)];
}
