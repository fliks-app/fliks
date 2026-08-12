export interface TableColumn {
  key: string;
  labelKey: string;
  format?: 'date' | 'bytes' | 'percent';
}

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
