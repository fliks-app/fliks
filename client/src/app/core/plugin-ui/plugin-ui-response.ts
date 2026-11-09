import type { ConfigPage, ReleasePickerRoutes, UiContribution } from '@fliks/plugin-ui';

/** One thing an acquisition provider searches: an indexer, an account. */
export interface AcquisitionSource {
  id: string;
  name: string;
  kinds: string[];
}

/** Per-entry `acquisition` of a provider: `order` is its rank in the admin provider order. */
export interface AcquisitionEntry {
  order: number;
  routes: ReleasePickerRoutes;
  sources: AcquisitionSource[];
}

/** A provider able to serve a kind at a level, with the sources that serve the kind. */
export interface AcquisitionProvider {
  pluginId: string;
  name: string;
  routes: ReleasePickerRoutes;
  sources: AcquisitionSource[];
}

/** `GET /api/plugins/ui` response entry, one per plugin with live contributions; the single declared shape, reconcile here if the backend differs. */
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
  /** Present on an acquisition provider (a plugin declaring `ui.releasePicker`). */
  acquisition?: AcquisitionEntry;
  /** Present on a metadata provider plugin. */
  provider?: { namespaces: string[]; kinds: string[]; lyrics?: boolean };
}
