import { PluginSummary } from '../../../core/services/api/plugins-api.service';

/** What the plugin is doing, in the order that matters to an operator: their own off switch,
 *  then a failed activation, then a process that is up but not answering. */
export function statusBadgeFor(row: PluginSummary): { labelKey: string; cssClass: string } {
  if (!row.enabled) return { labelKey: 'settings.plugins.status_disabled', cssClass: 'badge-ghost' };
  if (row.status === 'failed') return { labelKey: 'settings.plugins.status_failed', cssClass: 'badge-error' };
  if (row.processState && row.processState !== 'ready') {
    return { labelKey: 'settings.plugins.status_unavailable', cssClass: 'badge-warning' };
  }
  return { labelKey: 'settings.plugins.status_active', cssClass: 'badge-success' };
}

/** Why the badge reads what it reads: the boot failure, then the process stderr tail. */
export function statusDetail(row: PluginSummary): string | null {
  const parts = [row.status === 'failed' ? row.statusReason : null, row.statusMessage];
  return parts.filter((p) => p?.trim()).join('\n\n') || null;
}
