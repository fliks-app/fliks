/**
 * UI-facing contribution types carried by the manifest's `ui.*` block.
 * `client/src/app/core/plugin-ui/contribution.types.ts` mirrors this file
 * verbatim (types only); the CI drift gate diffs the two.
 */

/** The six slots a contribution can render into. */
export type SlotId =
  | 'nav.main'
  | 'nav.acquisition'
  | 'settings.page'
  | 'media.actions'
  | 'media.season.actions'
  | 'card.actions';

/**
 * Closed `when` vocabulary, evaluated with `.every()`. A leading "!"
 * negates any entry; an unknown predicate evaluates false (fail closed).
 */
export type WhenPredicateName =
  | 'isAdmin'
  | `hasPermission:${string}`
  | 'mediaType:movie'
  | 'mediaType:series'
  | 'hasFiles'
  | 'isMonitored'
  | 'hasQualityProfile'
  | 'isEpisode'
  | 'isTv'
  | 'isTouch';

/** A predicate, optionally negated. Negating an unknown predicate is still unknown, so still false. */
export type WhenPredicate = WhenPredicateName | `!${WhenPredicateName}`;

/** One `ui.contributions[]` entry — a nav item, action or menu row. */
export interface UiContribution {
  id: string;
  slot: SlotId;
  weight: number;
  labelKey: string;
  /** A shorter label for compact surfaces such as the phone dock; falls back to `labelKey`. */
  shortLabelKey?: string;
  icon?: string;
  tone?: 'default' | 'danger';
  badge?: string;
  confirmKey?: string;
  when?: WhenPredicate[];
  action: { kind: 'route'; path: string } | { kind: 'action'; actionId: string };
}

/** The seven field kinds `<app-schema-form>` renders, over four form components. */
export type FieldType = 'text' | 'email' | 'password' | 'url' | 'number' | 'toggle' | 'select';

/** One input of a plugin's settings form. */
export interface FieldDef {
  key: string;
  type: FieldType;
  labelKey: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /** Stripped from every read response; only written back when non-empty. */
  secret?: boolean;
  default?: string | number | boolean;
  options?: { value: string; labelKey: string }[];
  /** Written to a column on the row itself rather than into its `settings` bag.
   *  Without this a declared field silently stops persisting an entity column. */
  topLevel?: boolean;
}

/** One `ui.configPages[]` entry — a form-backed settings page under `plugin.<id>.`. */
/**
 * A page a plugin contributes, discriminated on `kind`. `form` is the default and the only
 * one that works with the process stopped; `providers` and `table` read the plugin's own
 * routes and therefore need it running.
 */
export type ConfigPage = FormConfigPage | ProvidersConfigPage | TableConfigPage;

interface ConfigPageBase {
  id: string;
  labelKey: string;
  icon?: string;
}

/** Rendered by `<app-schema-form>` over `app_settings`; omitting `kind` means this one. */
export interface FormConfigPage extends ConfigPageBase {
  kind?: 'form';
  fields: FieldDef[];
  /** Buttons core implements on the plugin's behalf. `actionId` names a closed catalogue core
   *  resolves; an unknown one renders nothing. A `data` plugin executes no code of its own, so
   *  this is the only way it can offer an action at all. */
  actions?: { id: string; labelKey: string; actionId: string }[];
}

/** One search/grab pair the core release picker calls for a given context. */
export interface ReleasePickerPair {
  /** `GET`, answering an array of scored releases. */
  search: string;
  /** `POST`, taking `{downloadUrl, sourceTitle?, sourceId?}`. */
  grab: string;
}

/**
 * Routes the core release picker calls, relative to the plugin — core prefixes each with
 * its proxy path and substitutes `:id`, `:seasonId` and `:episodeId` from the open title.
 * Declared by whichever plugin contributes the picker's menu entries; core holds no route
 * of its own for this, so with nothing declared the picker never opens.
 */
export interface ReleasePickerRoutes {
  movie: ReleasePickerPair;
  season: ReleasePickerPair;
  episode: ReleasePickerPair;
}

/** One column of a declared table — a `table` page's rows, or a row action's result. */
export interface TableColumn {
  key: string;
  labelKey: string;
  format?: 'date' | 'bytes' | 'percent';
}

/** One proxied route lists instances, another lists the implementations and their fields. */
export interface ProvidersConfigPage extends ConfigPageBase {
  kind: 'providers';
  list: string;
  implementations: string;
  /** Tests the unsaved draft — POSTs `{implementation, settings}` before any row is
   *  saved. Distinct from `actions[]`: there is no row yet, so no `:id` to substitute. */
  testConnection?: { route: string };
  /** `method` is explicit: encoding it into `route` left the caller POSTing to a
   *  string that contained the verb. Every `scope: 'row'` entry renders its own button —
   *  its route's `:id` is substituted with the row's id before the request ever fires. */
  actions?: {
    id: string;
    labelKey: string;
    method: 'GET' | 'POST' | 'DELETE';
    route: string;
    scope: 'row' | 'list';
    confirmKey?: string;
    /** How core renders what a `GET` answers — an array of rows, in declared columns.
     *  A `GET` without it renders no button: core has no domain view to fall back on. */
    result?: { kind: 'table'; columns: TableColumn[]; emptyKey: string };
  }[];
  reorderable?: boolean;
  /** Priority is not a universal provider concept; hide the column when the
   *  resource has none. */
  showPriority?: boolean;
  defaultPriority?: number;
  /** Overrides the generic provider-list wording, so a page reads in its own
   *  domain's terms rather than "New provider". */
  labels?: {
    newKey?: string;
    emptyKey?: string;
    testKey?: string;
    deleteConfirmKey?: string;
    /** The editor dialog's own titles — "New instance" reads like a placeholder on a page
     *  about indexers. */
    createTitleKey?: string;
    editTitleKey?: string;
  };
}

/** Read-mostly: declared columns and declared row actions, never a general grid. */
export interface TableConfigPage extends ConfigPageBase {
  kind: 'table';
  list: string;
  columns: TableColumn[];
  rowActions?: (
    | { kind: 'route'; labelKey: string; path: string }
    | { kind: 'action'; labelKey: string; actionId: string }
    | { kind: 'proxy'; labelKey: string; method: 'POST' | 'DELETE'; path: string; confirmKey?: string }
  )[];
  defaultSortKey?: string;
  /** `list` answers `{data,total,page,pageSize}` rather than a bare array — a
   *  paged resource renders empty against an array-only reader. */
  paged?: boolean;
  pageSize?: number;
  /** List-scope actions (clear-all and the like), distinct from `rowActions`. */
  listActions?: {
    labelKey: string;
    method: 'POST' | 'DELETE';
    path: string;
    confirmKey?: string;
  }[];
}
