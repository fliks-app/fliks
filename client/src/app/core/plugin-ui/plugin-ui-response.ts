import type { ConfigPage, ReleasePickerRoutes, UiContribution } from '@fliks/plugin-contract/ui';

/**
 * `GET /api/plugins/ui` response entry, one per plugin whose contributions
 * are currently live. Single declared shape — reconcile here if the
 * backend's differs; nothing else needs to change.
 */
export interface PluginUiEntry {
  pluginId: string;
  /** The plugin's manifest display name; absent on a backend that hasn't shipped it yet. */
  name?: string;
  contributions: UiContribution[];
  configPages: ConfigPage[];
  /** Translations to merge into ngx-translate so `labelKey` resolves. */
  i18n?: Record<string, Record<string, string>>;
  /** From `ui.releasePicker` — absent on a plugin that doesn't contribute one. */
  releasePicker?: ReleasePickerRoutes;
}
