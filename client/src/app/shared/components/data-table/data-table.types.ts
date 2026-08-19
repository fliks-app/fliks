/** Mirrors the contract's `BadgeTone`: the renderer maps a name to a class and falls back to
 *  `ghost`, so a declared string never reaches the rendered `class`. */
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

/** One value rendered under a cell's own. One level only: it carries no `subValues`. */
export interface TableSubValue {
  key: string;
  format?: 'date' | 'bytes' | 'percent';
  labelKeys?: Record<string, string>;
  badges?: Record<string, BadgeTone>;
}

export interface TableColumn {
  key: string;
  labelKey: string;
  format?: 'date' | 'bytes' | 'percent';
  /** Maps a cell value to a translate key — a status column renders its raw enum otherwise. */
  labelKeys?: Record<string, string>;
  /** Renders the cell as a badge, the value picking its tone; `*` covers every other value. */
  badges?: Record<string, BadgeTone>;
  /** Keeps the cell on one line. Implied for `format`ted and badged cells. */
  nowrap?: boolean;
  /** A second line of values under the cell's own. */
  subValues?: TableSubValue[];
  /** Another field of the row; when it has a value the cell opens a dialog showing it. */
  detailField?: string;
  /** Title of that dialog; falls back to the column's `labelKey`. */
  detailTitleKey?: string;
}

/** `TableConfigPage.filters[]` — value sent to `list` as a query param named by `key`. */
export type TableFilter =
  | { kind: 'search'; key: string; placeholderKey: string }
  | { kind: 'select'; key: string; labelKey: string; options: { value: string; labelKey: string }[] };

export type CellValue = string | number | boolean | null | undefined;

export interface TableRow {
  id: string | number;
  [key: string]: CellValue;
}

/** `list` answering `{data,total,page,pageSize}` instead of a bare array. */
export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `route`/`proxy` the renderer executes itself, `action` an id core resolves
 * — a plugin row invoking a flow it doesn't own.
 */
export type RowAction =
  | { kind: 'route'; labelKey: string; path: string }
  | { kind: 'action'; labelKey: string; actionId: string }
  | { kind: 'proxy'; labelKey: string; method: 'POST' | 'DELETE'; path: string; confirmKey?: string };

/** List-scope action (`TableConfigPage.listActions[]`) — rendered once, not per row. */
export interface ListAction {
  labelKey: string;
  method: 'POST' | 'DELETE';
  path: string;
  confirmKey?: string;
}
