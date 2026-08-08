/**
 * Mirror of `backend/src/common/plugin-contract/ui-contribution.ts`, types
 * only. The backend copy is the source of truth; a CI job diffs the two.
 *
 * NOTE: `client/src/app/core/plugins/` already exists and is the native
 * host bridge folder (desktop-player.bridge.ts, native-player.plugin.ts,
 * …). Plugin-UI code does not belong there — this is a separate folder.
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
export type WhenPredicate =
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

/** One `ui.contributions[]` entry — a nav item, action or menu row. */
export interface UiContribution {
  id: string;
  slot: SlotId;
  weight: number;
  labelKey: string;
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
