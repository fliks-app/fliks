import type {
  BadgeTone,
  ListAction,
  RowAction,
  TableColumn,
  TableFilter,
} from '../../shared/components/data-table/data-table.types';

const k = (key: string) => `acquisition_queue.${key}`;

export const QUEUE_URL = '/api/acquisition/queue';
export const HISTORY_URL = '/api/acquisition/history';

/** Both lists reload when a row joins or leaves; a provider's progress reports patch the queue rows in place. */
export const REFRESH_ON = ['queue.updated'];

export const STATE_LABELS: Record<string, string> = {
  queued: k('state_queued'),
  active: k('state_active'),
  stalled: k('state_stalled'),
  paused: k('state_paused'),
  importing: k('state_importing'),
  import_failed: k('state_import_failed'),
  imported: k('state_imported'),
  failed: k('state_failed'),
  removed: k('state_removed'),
};

const STATE_TONES: Record<string, BadgeTone> = {
  queued: 'neutral',
  active: 'info',
  stalled: 'warning',
  paused: 'ghost',
  importing: 'primary',
  import_failed: 'error',
  imported: 'success',
  failed: 'error',
  removed: 'ghost',
};

const stateColumn: TableColumn = {
  key: 'state',
  labelKey: k('col_state'),
  labelKeys: STATE_LABELS,
  badges: STATE_TONES,
  detailField: 'statusMessage',
  detailTitleKey: k('detail_reason'),
  progressField: 'progress',
};

const METHOD_LABELS = {
  auto: k('method_auto'),
  manual: k('method_manual'),
  rss: k('method_rss'),
};

const detail: RowAction = {
  kind: 'detail',
  labelKey: k('action_info'),
  titleKey: k('detail_title'),
  fields: [
    { key: 'sourceTitle', labelKey: k('detail_release') },
    { key: 'quality', labelKey: k('detail_quality') },
    { key: 'size', labelKey: k('detail_size'), format: 'bytes' },
    { key: 'source', labelKey: k('detail_source') },
    { key: 'method', labelKey: k('detail_method'), labelKeys: METHOD_LABELS },
    { key: 'date', labelKey: k('detail_date'), format: 'date' },
    { kind: 'link', key: 'infoUrl', labelKey: k('detail_link'), textKey: k('detail_link_open') },
  ],
};

export const QUEUE_COLUMNS: TableColumn[] = [
  {
    key: 'title',
    labelKey: k('col_title'),
    linkActionId: 'table.open-media',
    subValues: [{ key: 'source', badges: { '*': 'neutral' } }],
  },
  stateColumn,
  { key: 'size', labelKey: k('col_size'), format: 'bytes' },
  { key: 'bytesPerSecond', labelKey: k('col_speed'), format: 'speed' },
];

export const QUEUE_ACTIONS: RowAction[] = [
  detail,
  {
    kind: 'proxy',
    labelKey: k('action_pause'),
    method: 'POST',
    path: `${QUEUE_URL}/:id/pause`,
    visibleWhen: { key: 'state', in: ['queued', 'active', 'stalled'] },
  },
  {
    kind: 'proxy',
    labelKey: k('action_resume'),
    method: 'POST',
    path: `${QUEUE_URL}/:id/resume`,
    visibleWhen: { key: 'state', in: ['paused'] },
  },
  {
    kind: 'proxy',
    labelKey: k('action_retry_import'),
    method: 'POST',
    path: `${QUEUE_URL}/:id/retry-import`,
    visibleWhen: { key: 'state', in: ['import_failed'] },
  },
  {
    kind: 'proxy',
    labelKey: k('action_remove'),
    method: 'DELETE',
    path: `${QUEUE_URL}/:id`,
    confirmKey: k('remove_confirm'),
    confirmToggle: {
      labelKey: k('remove_blocklist'),
      hintKey: k('remove_blocklist_hint'),
      param: 'blocklist',
    },
    tone: 'danger',
  },
];

export const HISTORY_COLUMNS: TableColumn[] = [
  { key: 'date', labelKey: k('col_date'), format: 'date' },
  {
    key: 'title',
    labelKey: k('col_title'),
    linkActionId: 'table.open-media',
    subValues: [
      { key: 'quality', badges: { '*': 'ghost' } },
      { key: 'source', badges: { '*': 'neutral' } },
      { key: 'size', format: 'bytes', badges: { '*': 'ghost' } },
    ],
  },
  { key: 'method', labelKey: k('col_method'), labelKeys: METHOD_LABELS, nowrap: true },
  { key: 'state', labelKey: k('col_state'), labelKeys: STATE_LABELS, badges: STATE_TONES, detailField: 'statusMessage', detailTitleKey: k('detail_reason') },
];

export const HISTORY_FILTERS: TableFilter[] = [
  { kind: 'search', key: 'q', placeholderKey: k('filter_search') },
  {
    kind: 'select',
    key: 'state',
    labelKey: k('filter_state'),
    options: [
      { value: '', labelKey: k('filter_all') },
      { value: 'imported', labelKey: k('state_imported') },
      { value: 'failed', labelKey: k('state_failed') },
      { value: 'removed', labelKey: k('state_removed') },
    ],
  },
];

export const HISTORY_ACTIONS: RowAction[] = [
  detail,
  {
    kind: 'proxy',
    labelKey: k('action_delete'),
    method: 'DELETE',
    path: `${HISTORY_URL}/:id`,
    confirmKey: k('delete_confirm'),
    tone: 'danger',
  },
];

export const HISTORY_LIST_ACTIONS: ListAction[] = [
  {
    labelKey: k('action_clear'),
    method: 'DELETE',
    path: HISTORY_URL,
    confirmKey: k('clear_confirm'),
  },
];
