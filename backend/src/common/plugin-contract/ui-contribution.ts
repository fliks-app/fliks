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
}

/** One `ui.configPages[]` entry — a form-backed settings page under `plugin.<id>.`. */
export interface ConfigPage {
  id: string;
  labelKey: string;
  icon?: string;
  fields: FieldDef[];
}
