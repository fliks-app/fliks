import type { ConfigPage, UiContribution } from './contribution.types';

/**
 * `GET /api/plugins/ui` response entry, one per plugin whose contributions
 * are currently live. Single declared shape — reconcile here if the
 * backend's differs; nothing else needs to change.
 */
export interface PluginUiEntry {
  pluginId: string;
  contributions: UiContribution[];
  configPages: ConfigPage[];
  /** Translations to merge into ngx-translate so `labelKey` resolves. */
  i18n?: Record<string, Record<string, string>>;
}
