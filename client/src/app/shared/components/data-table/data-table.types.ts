export interface TableColumn {
  key: string;
  labelKey: string;
}

export type CellValue = string | number | boolean | null | undefined;

export interface TableRow {
  id: string | number;
  [key: string]: CellValue;
}

/**
 * The plan's `RowAction` union: `route`/`proxy` the renderer executes itself,
 * `action` an id core resolves — a plugin row invoking a flow it doesn't own.
 */
export type RowAction =
  | { kind: 'route'; labelKey: string; path: string }
  | { kind: 'action'; labelKey: string; actionId: string }
  | { kind: 'proxy'; labelKey: string; method: 'POST' | 'DELETE'; path: string; confirmKey?: string };
