import type { MediaType } from '../enums/media-type.enum';
/** UI-facing contribution types of the manifest's `ui.*` block, as the plugin host validates them
 *  (`server/docs/spec/plugins.md` rule 5); imported as `@fliks/plugin-ui`. */

/** The six slots a contribution can render into. */
export type SlotId =
  | 'nav.main'
  | 'nav.acquisition'
  | 'settings.page'
  | 'media.actions'
  | 'media.season.actions'
  | 'card.actions';

/** Closed `when` vocabulary, evaluated with `.every()`; a leading "!" negates, an unknown predicate is false. */
export type WhenPredicateName =
  | 'isAdmin'
  | `hasPermission:${string}`
  | `mediaType:${MediaType}`
  | 'hasFiles'
  | 'isMonitored'
  | 'hasQualityProfile'
  | 'isEpisode'
  /** False when the title has no metadata-provider id (tmdbId/tvdbId/imdbId all null). */
  | 'identified'
  | 'isTv'
  | 'isTouch'
  /** The signed-in user has at least one Live TV channel to watch. */
  | 'liveTv'
  /** The connected server is at least this release, e.g. `server:5.1.0`. */
  | `server:${string}`
  /** Which menu is being built; a row names this only when it belongs to the card menu or the detail menu. */
  | 'surface:card'
  | 'surface:detail';

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
  action:
    | { kind: 'route'; path: string }
    | { kind: 'action'; actionId: string }
    /** A row that only opens its `children`; older clients drop the row, hiding the group. */
    | { kind: 'submenu' };
  /** Rows nested under this one. Only meaningful with `action.kind: 'submenu'`;
   *  a plugin can hand over a whole group this way. */
  children?: UiContribution[];
}

/** Key a read response adds to `settings` naming the `secret: true` fields holding a stored value. Read-only: strip it on write. */
export const SECRETS_SET_KEY = 'secretsSet';

/** The eight field kinds `<app-schema-form>` renders, over four form components. */
export type FieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'url'
  | 'number'
  | 'toggle'
  | 'select'
  | 'multiselect';

/** One input of a plugin's settings form; `kind` defaults to `'field'`. */
export interface FieldDef {
  kind?: 'field';
  key: string;
  type: FieldType;
  labelKey: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /** Stripped from every read response; only written back when non-empty. A resource lists its set keys
   *  under `SECRETS_SET_KEY` and treats an incoming `null` as "erase" (blank already means "unchanged"). */
  secret?: boolean;
  /** A `string[]` only for `multiselect`, which is the set a new row starts from. */
  default?: string | number | boolean | string[];
  /** Required for `multiselect`. For that type the value is a `string[]` of the declared
   *  `options[].value`. */
  options?: { value: string; labelKey: string }[];
  /** Written to a column on the row itself rather than into its `settings` bag.
   *  Without this a declared field silently stops persisting an entity column. */
  topLevel?: boolean;
  /** Authoring affordances checked by the renderer, not a trust boundary (the settings endpoint is admin-gated). */
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

/** Static explanatory text between fields — carries no value, renders no input. */
export interface FormCaption {
  kind: 'caption';
  textKey: string;
}

/** A labelled section of input fields. One level only: `fields` is `FieldDef[]`, not
 *  `FormItem[]`, so a group inside a group is impossible in the type, not just undocumented. */
export interface FormGroup {
  kind: 'group';
  labelKey: string;
  fields: FieldDef[];
}

/** A read-only line showing the current value of `plugin.<id>.<settingKey>` — whatever the
 *  plugin last wrote there via `config.set`. Needs no route, so it still works stopped. */
export interface FormStatus {
  kind: 'status';
  labelKey: string;
  settingKey: string;
}

/** One item of a `form` page, in declared order. A bare field (no `kind`, or `kind: 'field'`)
 *  is the input the page has always rendered. */
export type FormItem = FieldDef | FormCaption | FormGroup | FormStatus;

/** One `ui.configPages[]` entry — a form-backed settings page under `plugin.<id>.`. */
/** A page a plugin contributes, discriminated on `kind`; only `form` works with the process stopped. */
export type ConfigPage = FormConfigPage | ProvidersConfigPage | TableConfigPage;

interface ConfigPageBase {
  id: string;
  labelKey: string;
  icon?: string;
  /** One explanatory line under the page title, like every core settings page carries. */
  subtitleKey?: string;
}

/** Rendered by `<app-schema-form>` over `app_settings`; omitting `kind` means this one. */
/** Every `actionId` a `form` page's button may name; an unknown value renders nothing. */
export const FORM_ACTION_IDS = ['events.test-delivery'] as const;
export type FormActionId = (typeof FORM_ACTION_IDS)[number];

/** Every `actionId` a `table` row action may name, resolved against its row; an unknown value renders nothing. */
export const TABLE_ROW_ACTION_IDS = ['table.open-media'] as const;
export type TableRowActionId = (typeof TABLE_ROW_ACTION_IDS)[number];

/** Where a `providers` row action renders instead of its own button; an unknown value falls back to a plain button. */
export const PROVIDER_ROW_ACTION_SLOTS = ['cooldown-reset'] as const;
export type ProviderRowActionSlot = (typeof PROVIDER_ROW_ACTION_SLOTS)[number];

export interface FormConfigPage extends ConfigPageBase {
  kind?: 'form';
  fields: FormItem[];
  /** Buttons core implements on the plugin's behalf. A `data` plugin executes no code of its
   *  own, so this is the only way it can offer an action at all. */
  actions?: { id: string; labelKey: string; actionId: FormActionId }[];
}

/** One search/grab pair the core release picker calls for a given context. */
export interface ReleasePickerPair {
  /** `GET`, answering an array of scored releases. */
  search: string;
  /** `POST`, taking `{downloadUrl, sourceTitle?, sourceId?}`. */
  grab: string;
}

export type ReleasePickerKind = 'movie' | 'series' | 'book' | 'comic' | 'album';
/** `work` is the whole title, `group` a season, `item` an episode. */
export type ReleasePickerLevel = 'work' | 'group' | 'item';

/** Routes the core release picker calls per kind and level, relative to the plugin; `:id`, `:seasonId`,
 *  `:episodeId` are substituted. A level a plugin does not declare never opens the picker.
 *  A 6.x server sends `byKind` and the three pairs; a 5.x server sends the three pairs only. */
export interface ReleasePickerRoutes {
  byKind?: Partial<Record<ReleasePickerKind, Partial<Record<ReleasePickerLevel, ReleasePickerPair>>>>;
  movie?: ReleasePickerPair;
  season?: ReleasePickerPair;
  episode?: ReleasePickerPair;
}

/** daisyUI badge tones. Closed: core maps a name to a class and falls back to `ghost`,
 *  so a manifest can never put a string of its own into the rendered `class`. */
export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'ghost';

/** One value rendered under a cell's own, as a badge or plain text; one level only. */
export interface TableSubValue {
  key: string;
  format?: 'date' | 'bytes' | 'percent' | 'speed';
  labelKeys?: Record<string, string>;
  badges?: Record<string, BadgeTone>;
}

/** One column of a declared table — a `table` page's rows, or a row action's result. */
export interface TableColumn {
  key: string;
  labelKey: string;
  format?: 'date' | 'bytes' | 'percent' | 'speed';
  /** Maps a cell value to a translate key — a status column renders its raw enum otherwise. */
  labelKeys?: Record<string, string>;
  /** Renders the cell as a badge, the value picking its tone; `*` covers every other value. `format`ted cells are never badged. */
  badges?: Record<string, BadgeTone>;
  /** Keeps the cell on one line. Implied for `format`ted and badged cells. */
  nowrap?: boolean;
  /** Clips the value to one line with an ellipsis, full text on hover. For the one column
   *  carrying free text (a release name), which otherwise wraps a row over several lines. */
  truncate?: boolean;
  /** A second line under the cell's own value. A release's quality and tracker belong with
   *  its name; as columns of their own they cost width the title needed. */
  subValues?: TableSubValue[];
  /** Names another field of the row (not a translation key); when set, the cell opens a dialog showing it. */
  detailField?: string;
  /** Title of that dialog. Falls back to the column's own `labelKey`. */
  detailTitleKey?: string;
  /** Turns the cell into a link running this core action; an unknown id or unresolvable row renders plain text. */
  linkActionId?: TableRowActionId;
  /** Names a 0–100 field; a badged cell fills left-to-right with it. Ignored without `badges` or on a non-number. */
  progressField?: string;
}

/** One line of a `detail` row action's dialog; `kind: 'link'` anchors the URL under `key`, refused unless
 *  `http:`/`https:` (it comes from an indexer). Empty row values are skipped. */
export type TableDetailField =
  | {
      kind?: 'value';
      key: string;
      labelKey: string;
      format?: 'date' | 'bytes' | 'percent' | 'speed';
      labelKeys?: Record<string, string>;
    }
  | { kind: 'link'; key: string; labelKey: string; textKey: string };

/** One `rowActions[]` visibility clause read off the row: renders only when the row's `key` holds one of `in`. */
export interface TableRowCondition {
  key: string;
  in: (string | number | boolean)[];
}

/** One proxied route lists instances, another lists the implementations and their fields. */
export interface ProvidersConfigPage extends ConfigPageBase {
  kind: 'providers';
  list: string;
  implementations: string;
  /** Tests the unsaved draft by POSTing `{implementation, settings, id?}`; a blank secret is omitted and `id` lets the resource use the stored one. */
  testConnection?: { route: string };
  /** `method` is explicit rather than encoded in `route`; a `scope: 'row'` entry substitutes `:id` with the row's id. */
  actions?: {
    id: string;
    labelKey: string;
    method: 'GET' | 'POST' | 'DELETE';
    route: string;
    scope: 'row' | 'list';
    confirmKey?: string;
    /** Renders this action in a known place rather than as its own button. `scope: 'row'` only. */
    slot?: ProviderRowActionSlot;
    /** How core renders what a `GET` answers — an array of rows, in declared columns.
     *  A `GET` without it renders no button: core has no domain view to fall back on. */
    result?: { kind: 'table'; columns: TableColumn[]; emptyKey: string };
    /** Toasted after a successful mutation, interpolated with the fields of what it answered. */
    successKey?: string;
    /** Also runs, unconfirmed, on the row the editor just saved when that row is enabled. `scope: 'row'` only. */
    afterSave?: boolean;
  }[];
  reorderable?: boolean;
  /** Adds a selection column and bulk actions; opt-in per page. */
  bulkSelect?: boolean;
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

/** Cap on how many `preRoll` items core will ever forward from one `playback-info` call —
 *  a plugin's route may answer more, but everything past this is dropped. */
export const PRE_ROLL_ITEMS_MAX = 5;

/** One pre-roll candidate a plugin's route may offer. It names a library file — there is no
 *  URL and no path here — so core resolves and ACL-checks it the same way as the main item. */
export interface PreRollItem {
  mediaFileId: number;
  labelKey?: string;
  skippable?: boolean;
}

/** `ui.player` — the one POST route, declared in the manifest's own `routes[]` like
 *  `releasePicker`'s, that core calls before playback to ask for pre-roll candidates. */
export interface PlayerDeclaration {
  preRollRoute: string;
}

/** Floor for both `refreshMs` and the coalescing of `refreshOn`: a list refetch is a round
 *  trip per viewer, and no queue reads usefully faster than this. */
export const TABLE_REFRESH_MIN_MS = 2000;

/** One `table` filter — its current value is sent to `list` as a query param named by
 *  `key`; an empty value is omitted. Filtering itself is the plugin's job, core only forwards it. */
export type TableFilter =
  | { kind: 'search'; key: string; placeholderKey: string }
  | { kind: 'select'; key: string; labelKey: string; options: { value: string; labelKey: string }[] };

/** Read-mostly: declared columns and declared row actions, never a general grid. */
export interface TableConfigPage extends ConfigPageBase {
  kind: 'table';
  list: string;
  columns: TableColumn[];
  filters?: TableFilter[];
  /** Adds a selection column and turns the declared `proxy` row actions into batch actions,
   *  one confirmation for the whole selection instead of one per row. */
  bulkSelect?: boolean;
  /** `when` gates on the viewer (same vocabulary as `ui.contributions[]`), `visibleWhen` on the row; presentation
   *  only, the route is CASL-guarded. A `proxy` path may carry `:id`, substituted with the row's id. */
  rowActions?: (
    | { kind: 'route'; labelKey: string; path: string; when?: WhenPredicate[]; visibleWhen?: TableRowCondition }
    | {
        kind: 'action';
        labelKey: string;
        actionId: TableRowActionId;
        when?: WhenPredicate[];
        visibleWhen?: TableRowCondition;
      }
    /** Opens a dialog of declared fields read off the row. Needs no route: everything it shows
     *  is already on the row the table loaded. */
    | {
        kind: 'detail';
        labelKey: string;
        titleKey?: string;
        fields: TableDetailField[];
        when?: WhenPredicate[];
        visibleWhen?: TableRowCondition;
      }
    | {
        kind: 'proxy';
        labelKey: string;
        method: 'POST' | 'DELETE';
        path: string;
        confirmKey?: string;
        /** Renders a checkbox in the confirmation sending its state as query param `param`; needs `confirmKey`. `hintKey` is the line under it. */
        confirmToggle?: { labelKey: string; param: string; hintKey?: string };
        /** Danger styling on the button — a destructive row action must not look like the
         *  two beside it. */
        tone?: 'default' | 'danger';
        when?: WhenPredicate[];
        visibleWhen?: TableRowCondition;
      }
  )[];
  defaultSortKey?: string;
  /** `list` answers `{data,total,page,pageSize}` rather than a bare array — a
   *  paged resource renders empty against an array-only reader. */
  paged?: boolean;
  pageSize?: number;
  /** Re-fetch this often while visible, clamped to {@link TABLE_REFRESH_MIN_MS}. Prefer `refreshOn`; this is for values no event announces. */
  refreshMs?: number;
  /** Core SSE event types that re-fetch the list as they arrive, coalesced to at most one
   *  fetch per {@link TABLE_REFRESH_MIN_MS}. */
  refreshOn?: string[];
  /** List-scope actions (clear-all and the like), distinct from `rowActions`. `when` gates on the
   *  viewer exactly as a row action's does; an older client ignores it and renders the button. */
  listActions?: {
    labelKey: string;
    method: 'POST' | 'DELETE';
    path: string;
    confirmKey?: string;
    when?: WhenPredicate[];
  }[];
}
