import type { FieldDef, TableColumn } from '@fliks/plugin-contract/ui';

/**
 * The generic shape a provider-list consumer's wire format already fits.
 * Extra backend-specific fields (e.g. subtitle providers' rate-limit state)
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

/** One driver a provider instance can be created against — a `ProvidersConfigPage.implementations[]` entry. */
export interface ProviderImplementation {
  implementation: string;
  labelKey: string;
  fields: FieldDef[];
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/** The draft passed to `testConnection` — the unsaved form, never a persisted row. */
export interface ProviderDraft {
  implementation: string;
  settings: Record<string, unknown>;
  /** The row being edited, absent when the draft is new. Lets the resource resolve a blank
   *  secret against what it already stored instead of making the user retype it. */
  id?: number;
}

/** A list-scope action (`ProvidersConfigPage.actions[].scope: 'list'`) — rendered
 *  once above the rows, not per row. `run` owns the request; the component only reloads after. */
export interface ProviderListAction {
  labelKey: string;
  run: () => Promise<void>;
}

/** A row-scope action (`ProvidersConfigPage.actions[].scope: 'row'`), host-prefixed but with
 *  `:id` still in `route` — substituting it against the row, and never firing if a placeholder
 *  survives that, is this component's job because only it holds the row. */
export interface ProviderRowAction {
  labelKey: string;
  method: 'GET' | 'POST' | 'DELETE';
  route: string;
  confirmKey?: string;
  /** How a `GET`'s answer renders (`ProvidersConfigPage.actions[].result`). */
  result?: { kind: 'table'; columns: TableColumn[]; emptyKey: string };
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
