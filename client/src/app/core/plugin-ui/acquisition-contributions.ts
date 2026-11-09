import type { UiContribution } from '@fliks/plugin-ui';
import type { AcquisitionLevel } from '../media-kinds';
import { evaluateWhen, type WhenContext } from './when-evaluator';

const PREFIX = { work: 'media', group: 'group', item: 'item' } as const;
const SLOT = { work: 'media.actions', group: 'media.group.actions', item: 'media.item.actions' } as const;

/** Core's "Files" submenu of a level, just above "Advanced": shown once a provider has a source serving the kind at that level. */
function groupOf(level: AcquisitionLevel): UiContribution {
  const row = (id: string, weight: number, labelKey: string, icon: string, actionId: string): UiContribution => ({
    id: `${id}_${level}`,
    slot: SLOT[level],
    weight,
    labelKey,
    icon,
    action: { kind: 'action', actionId: `${PREFIX[level]}.${actionId}` },
  });
  return {
    id: `core.files_group_${level}`,
    slot: SLOT[level],
    weight: 1050,
    labelKey: 'media_detail.files_group',
    icon: 'download',
    when: ['hasPermission:media.grab', 'hasQualityProfile', 'hasAcquisitionProvider'],
    action: { kind: 'submenu' },
    children: [
      row('core.search_releases', 10, 'media_detail.search_releases', 'search', 'search-releases'),
      row('core.grab_best', 20, 'media_detail.grab_best', 'zap', 'grab-best'),
    ],
  };
}

export const CORE_ACQUISITION_ACTIONS: Record<AcquisitionLevel, UiContribution> = {
  work: groupOf('work'),
  group: groupOf('group'),
  item: groupOf('item'),
};

/** Core's submenu when it passes `ctx`, plus the plugin rows minus any that offer one of its actions. A plugin row still shows (under its
 *  own `when`) where core's does not, which keeps a provider that has not published sources reachable. */
export function withCoreAcquisition(
  level: AcquisitionLevel,
  ctx: WhenContext,
  plugin: readonly UiContribution[],
): UiContribution[] {
  const group = CORE_ACQUISITION_ACTIONS[level];
  if (!evaluateWhen(group.when, ctx)) return [...plugin];
  const owned = new Set((group.children ?? []).map((c) => (c.action.kind === 'action' ? c.action.actionId : '')));
  const keep = (c: UiContribution) => !(c.action.kind === 'action' && owned.has(c.action.actionId));
  return [group, ...plugin.filter(keep)];
}
