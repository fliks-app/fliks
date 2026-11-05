import type { TableConfigPage } from '../../../core/plugin-ui/ui-contribution';

/** The table vocabulary is the plugin contract's: one definition, here only re-exported. */
export type {
  BadgeTone,
  TableColumn,
  TableDetailField,
  TableFilter,
  TableRowAction,
  TableRowCondition,
  TableSubValue,
} from '../../../core/plugin-ui/ui-contribution';

export type RowAction = NonNullable<TableConfigPage['rowActions']>[number];

/** A row action ready to run; a submenu carries the children left for the row instead. */
export interface RowActionItem {
  action: RowAction;
  run: () => void | Promise<void>;
  children?: RowActionItem[];
}

/** Opens the release picker for one row; `grabbed` runs once a release was taken. */
export type OpenReleases = (
  picker: { titleKey: string; search: string; grab: string },
  grabbed: () => void,
) => void;
export type ListAction = NonNullable<TableConfigPage['listActions']>[number];

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
