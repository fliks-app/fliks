import type { FieldDef } from '../../../core/plugin-ui/contribution.types';

/**
 * The generic shape `indexers`/`download_clients`/`subtitle_providers` already
 * share on the wire. Extra backend-specific fields (e.g. indexers' `cooldown`)
 * pass through untouched — the renderer never reads them.
 */
export interface ProviderInstance {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  settings?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** A field stored as a sibling of `settings` on the wire instead of nested in it. */
export interface ProviderFieldDef extends FieldDef {
  topLevel?: boolean;
}

/** One driver a provider instance can be created against — the plan's `ProvidersView.implementations[]` entry. */
export interface ProviderImplementation {
  implementation: string;
  labelKey: string;
  fields: ProviderFieldDef[];
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/** The draft passed to `testConnection` — the unsaved form, never a persisted row. */
export interface ProviderDraft {
  implementation: string;
  settings: Record<string, unknown>;
}

export interface ProviderListLabels {
  newLabelKey: string;
  colNameKey: string;
  colImplementationKey: string;
  colPriorityKey: string;
  colEnabledKey: string;
  actionsKey: string;
  editKey: string;
  deleteKey: string;
  saveKey: string;
  cancelKey: string;
  createTitleKey: string;
  editTitleKey: string;
  fieldNameKey: string;
  fieldImplementationKey: string;
  fieldPriorityKey: string;
  fieldEnabledKey: string;
  emptyKey: string;
  loadErrorKey: string;
  confirmDeleteKey: string;
  deleteErrorKey: string;
  testConnectionKey?: string;
}
