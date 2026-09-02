/**
 * UI-facing contribution types carried by the manifest's `ui.*` block. The client imports this
 * very file through its `@fliks/plugin-contract/ui` path alias, so there is nothing to keep in
 * sync: a change here reaches both sides or compiles on neither.
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
  | 'isTouch'
  /** Which menu is being built. The card menu and the media detail menu read the
   *  same contributions, so a row only names this when it belongs to one of
   *  them — 'Play' means nothing on a detail page you are already on. */
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
    /** A row that only opens the `children` below it. Older clients don't know
     *  this kind and drop the row, which hides the group rather than showing a
     *  parent that does nothing. */
    | { kind: 'submenu' };
  /** Rows nested under this one. Only meaningful with `action.kind: 'submenu'`;
   *  a plugin can hand over a whole group this way. */
  children?: UiContribution[];
}

/**
 * Key a read response adds to `settings` to name the `secret: true` fields that hold a stored
 * value — the editor renders those masked and offers to erase them. Read-only: a resource must
 * strip it on write rather than persist it.
 */
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

/**
 * One input of a plugin's settings form. `kind` is optional and defaults to `'field'` —
 * a manifest declaring plain fields today needs no change to keep installing and rendering.
 */
export interface FieldDef {
  kind?: 'field';
  key: string;
  type: FieldType;
  labelKey: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /**
   * Stripped from every read response; only written back when non-empty. A resource honouring
   * this lists its set keys under `SECRETS_SET_KEY` so the editor can mask a stored value it
   * never receives, and treats an incoming `null` as "erase it" — blank already means
   * "unchanged", so removal needs a spelling of its own (the one JSON Merge Patch uses).
   */
  secret?: boolean;
  /** A `string[]` only for `multiselect`, which is the set a new row starts from. */
  default?: string | number | boolean | string[];
  /** Required for `multiselect`. For that type the value is a `string[]` of the declared
   *  `options[].value`. */
  options?: { value: string; labelKey: string }[];
  /** Written to a column on the row itself rather than into its `settings` bag.
   *  Without this a declared field silently stops persisting an entity column. */
  topLevel?: boolean;
  /**
   * All optional, all authoring affordances checked by the renderer before it will save — not a
   * trust boundary, since the settings endpoint behind this page is already admin-gated.
   */
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
  /** One explanatory line under the page title, like every core settings page carries. */
  subtitleKey?: string;
}

/** Rendered by `<app-schema-form>` over `app_settings`; omitting `kind` means this one. */
/**
 * Every `actionId` a `form` page's button may name. Core implements each one; an unknown value
 * renders nothing, so this list is the whole vocabulary available to a manifest.
 */
export const FORM_ACTION_IDS = ['events.test-delivery'] as const;
export type FormActionId = (typeof FORM_ACTION_IDS)[number];

/**
 * Every `actionId` a `table` row action may name, resolved by core against the row it sits on.
 * Same rule: an unknown value renders nothing.
 */
export const TABLE_ROW_ACTION_IDS = ['table.open-media'] as const;
export type TableRowActionId = (typeof TABLE_ROW_ACTION_IDS)[number];

/**
 * Where a `providers` row action renders instead of as its own labelled button. `cooldown-reset`
 * puts it beside the cooldown a row reports, so clearing one sits next to the thing it clears.
 * Closed vocabulary: an unknown value falls back to a plain button rather than disappearing.
 */
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

/** One value rendered under a cell's own, as a badge or as plain text. One level only:
 *  it carries no `subValues` of its own, so a sub-value under a sub-value is impossible
 *  in the type rather than merely undocumented. */
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
  /** Renders the cell as a badge, the value picking its tone. `*` covers every other value,
   *  which is how an open-ended column (a quality name) gets one uniform tone. A `format`ted
   *  cell is never badged. */
  badges?: Record<string, BadgeTone>;
  /** Keeps the cell on one line. Implied for `format`ted and badged cells. */
  nowrap?: boolean;
  /** Clips the value to one line with an ellipsis, full text on hover. For the one column
   *  carrying free text (a release name), which otherwise wraps a row over several lines. */
  truncate?: boolean;
  /** A second line under the cell's own value. A release's quality and tracker belong with
   *  its name; as columns of their own they cost width the title needed. */
  subValues?: TableSubValue[];
  /** Names another field of the row — not a translation key, hence no `Key` suffix. When that
   *  field has a value, the cell becomes a button opening a dialog that shows it: a long
   *  diagnostic message reads there instead of stretching a column across every row. */
  detailField?: string;
  /** Title of that dialog. Falls back to the column's own `labelKey`. */
  detailTitleKey?: string;
  /** Turns the cell into a link running this core action against its row. Same closed
   *  vocabulary as a row action's `actionId`, and the same fail-closed rule: an id core does not
   *  recognise, or a row the action cannot resolve, renders plain text rather than a dead link. */
  linkActionId?: TableRowActionId;
  /** Names a 0–100 field on the row; a badged cell then fills left-to-right with it and appends
   *  the percent. A moving value belongs inside the badge naming what is moving — as its own
   *  column it costs width and reads as unrelated to the state beside it. Ignored on a cell that
   *  declares no `badges`, and on a row whose named field is not a number. */
  progressField?: string;
}

/**
 * One line of a `detail` row action's dialog. A plain field renders its value; `kind: 'link'`
 * renders `textKey` as an anchor to the URL the row holds under `key`, which core refuses
 * unless it is `http:` or `https:` — the value comes from an indexer, not from the manifest.
 * A field whose row value is empty is skipped, so one dialog serves rows of differing shape.
 */
export type TableDetailField =
  | {
      kind?: 'value';
      key: string;
      labelKey: string;
      format?: 'date' | 'bytes' | 'percent' | 'speed';
      labelKeys?: Record<string, string>;
    }
  | { kind: 'link'; key: string; labelKey: string; textKey: string };

/** One `rowActions[]` visibility clause, read off the row itself: the action renders only when
 *  the row's `key` holds one of `in`. Pausing a paused download is not an action, it is a button
 *  that fails. Distinct from `when`, which reads the viewer rather than the row. */
export interface TableRowCondition {
  key: string;
  in: (string | number | boolean)[];
}

/** One proxied route lists instances, another lists the implementations and their fields. */
export interface ProvidersConfigPage extends ConfigPageBase {
  kind: 'providers';
  list: string;
  implementations: string;
  /** Tests the unsaved draft — POSTs `{implementation, settings, id?}` before it is saved.
   *  Distinct from `actions[]`: there is no route parameter, and on a new draft no row exists
   *  at all. A blank secret is omitted from `settings`, and `id` names the row being edited,
   *  so the resource resolves it against what it stored rather than asking the user again. */
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
    /** Renders this action in a known place rather than as its own button. `scope: 'row'` only. */
    slot?: ProviderRowActionSlot;
    /** How core renders what a `GET` answers — an array of rows, in declared columns.
     *  A `GET` without it renders no button: core has no domain view to fall back on. */
    result?: { kind: 'table'; columns: TableColumn[]; emptyKey: string };
  }[];
  reorderable?: boolean;
  /** Adds a selection column and the bulk actions that act on it (enable, disable, delete, and
   *  one editor applied to every selected row). Opt-in per page: a list whose rows are edited one
   *  at a time should not grow a column asking to be ticked. */
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
  /**
   * `when` gates on the viewer (the same closed predicate vocabulary `ui.contributions[]` uses —
   * a mutating action names the permission its route is declared under, so the button is absent
   * rather than answering 403); `visibleWhen` gates on the row. Both are presentation only:
   * the route behind the button is CASL-guarded regardless.
   *
   * A `proxy` path may carry `:id`, substituted with the row's own `id` before the request fires.
   */
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
        /** Renders a checkbox inside that confirmation and sends its state as the query
         *  parameter `param`. Needs `confirmKey`: a toggle with no dialog to sit in never
         *  renders, and would silently send its default. `hintKey` is the line under it, for
         *  what the choice does *not* do — the part a label long enough to say it stops being
         *  a label. */
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
  /** Re-fetch this often while the page is on screen, for a list whose values move on
   *  their own. Clamped to {@link TABLE_REFRESH_MIN_MS}; polling stops while the tab is
   *  hidden. Prefer `refreshOn` — this is for values no event announces. */
  refreshMs?: number;
  /** Core SSE event types that re-fetch the list as they arrive, coalesced to at most one
   *  fetch per {@link TABLE_REFRESH_MIN_MS}. */
  refreshOn?: string[];
  /** List-scope actions (clear-all and the like), distinct from `rowActions`. */
  listActions?: {
    labelKey: string;
    method: 'POST' | 'DELETE';
    path: string;
    confirmKey?: string;
  }[];
}
