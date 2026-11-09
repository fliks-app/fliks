import type { UiContribution } from '@fliks/plugin-ui';
import type { AcquisitionLevel } from '../media-kinds';
import { evaluateWhen, type WhenContext } from './when-evaluator';

const PREFIX = { work: 'media', group: 'group', item: 'item' } as const;
const SLOT = { work: 'media.actions', group: 'media.group.actions', item: 'media.item.actions' } as const;

const ACQUIRE: UiContribution['when'] = ['hasPermission:media.grab', 'hasQualityProfile', 'hasAcquisitionProvider'];

/** Core's "Files" submenu of a level, just above "Advanced": the release search and grab once a provider has a source serving the
 *  kind at that level, and the tracking status of a monitored target. */
function groupOf(level: AcquisitionLevel): UiContribution {
  const row = (id: string, weight: number, labelKey: string, icon: string, actionId: string, when: UiContribution['when']): UiContribution => ({
    id: `${id}_${level}`,
    slot: SLOT[level],
    weight,
    labelKey,
    icon,
    when,
    action: { kind: 'action', actionId: `${PREFIX[level]}.${actionId}` },
  });
  return {
    id: `core.files_group_${level}`,
    slot: SLOT[level],
    weight: 1050,
    labelKey: 'media_detail.files_group',
    icon: 'download',
    action: { kind: 'submenu' },
    children: [
      row('core.search_releases', 10, 'media_detail.search_releases', 'search', 'search-releases', ACQUIRE),
      row('core.grab_best', 20, 'media_detail.grab_best', 'zap', 'grab-best', ACQUIRE),
      // The server tracks the video kinds only (`media/tracking.rs`).
      row('core.tracking', 30, 'tracking.menu_item', 'list-checks', 'open-tracking', ['isMonitored', '!mediaType:book', '!mediaType:comic', '!mediaType:album']),
    ],
  };
}

export const CORE_ACQUISITION_ACTIONS: Record<AcquisitionLevel, UiContribution> = {
  work: groupOf('work'),
  group: groupOf('group'),
  item: groupOf('item'),
};

/** Core's submenu holding only the rows that pass (the menu drops it when none does), plus the plugin rows minus any that offer one of
 *  them. A plugin row still shows (under its own `when`) where core's does not, which keeps a provider without published sources reachable. */
export function withCoreAcquisition(
  level: AcquisitionLevel,
  ctx: WhenContext,
  plugin: readonly UiContribution[],
): UiContribution[] {
  const group = CORE_ACQUISITION_ACTIONS[level];
  const shown = (group.children ?? []).filter((c) => evaluateWhen(c.when, ctx));
  const owned = new Set(shown.map((c) => (c.action.kind === 'action' ? c.action.actionId : '')));
  const keep = (c: UiContribution) => !(c.action.kind === 'action' && owned.has(c.action.actionId));
  return [{ ...group, children: shown }, ...plugin.filter(keep)];
}
