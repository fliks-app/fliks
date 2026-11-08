// Wire contract: smart playlists (`playlists.rules`), camelCase JSON, validated server-side with deny_unknown_fields

export const SORT_BY = [
  'artist', 'album', 'title', 'year', 'rating', 'playCount', 'lastPlayed', 'addedAt', 'duration', 'popularity', 'random',
] as const;
export type SortBy = (typeof SORT_BY)[number];

export type Range = { min?: number; max?: number };

export type Criterion =
  | { type: 'artist' | 'albumArtist' | 'composer' | 'genre'; name: string }
  | { type: 'work'; title: string }
  | ({ type: 'year' | 'originalYear' | 'rating' | 'playCount' | 'popularity' } & Range)
  | { type: 'releaseType'; types: string[] }
  | { type: 'compilation' | 'favourite' | 'lossless'; value: boolean }
  | { type: 'lastPlayed' | 'addedAt'; withinDays?: number; olderThanDays?: number }
  | { type: 'duration'; minSeconds?: number; maxSeconds?: number }
  | { type: 'codec'; codecs: string[] }
  | { type: 'library'; ids: number[] };
export type CriterionType = Criterion['type'];

export interface SmartRules {
  match: 'all' | 'any';
  criteria: Criterion[];
  sort: { by: SortBy; descending: boolean };
  limit: number | null;
}

export const CRITERION_TYPES: readonly CriterionType[] = [
  'artist', 'albumArtist', 'composer', 'work', 'genre', 'year', 'originalYear', 'releaseType', 'compilation', 'rating',
  'favourite', 'playCount', 'lastPlayed', 'addedAt', 'duration', 'lossless', 'codec', 'popularity', 'library',
];

/** Album primary and secondary types the server accepts, with their i18n key suffix. */
export const RELEASE_TYPES: readonly { value: string; key: string }[] = [
  'album', 'single', 'ep', 'broadcast', 'other', 'compilation', 'soundtrack', 'spokenword', 'interview', 'audiobook',
  'audio drama', 'live', 'remix', 'dj-mix', 'mixtape/street', 'demo', 'field recording',
].map((value) => ({ value, key: value.replace(/[^a-z]+/g, '_') }));

export type FieldKind = 'text' | 'int' | 'float' | 'bool' | 'types' | 'codecs' | 'libraries';
export interface Field {
  key: string;
  kind: FieldKind;
  /** i18n key under `playlists.`. */
  label: string;
}

const MIN_MAX: Field[] = [
  { key: 'min', kind: 'int', label: 'f_min' },
  { key: 'max', kind: 'int', label: 'f_max' },
];
const DAYS: Field[] = [
  { key: 'withinDays', kind: 'int', label: 'f_within' },
  { key: 'olderThanDays', kind: 'int', label: 'f_older' },
];
const NAME: Field[] = [{ key: 'name', kind: 'text', label: 'f_name' }];
const VALUE: Field[] = [{ key: 'value', kind: 'bool', label: 'f_value' }];

export const CRITERION_FIELDS: Record<CriterionType, Field[]> = {
  artist: NAME, albumArtist: NAME, composer: NAME, genre: NAME,
  work: [{ key: 'title', kind: 'text', label: 'f_title' }],
  year: MIN_MAX, originalYear: MIN_MAX, rating: MIN_MAX, playCount: MIN_MAX,
  popularity: [{ key: 'min', kind: 'float', label: 'f_min' }, { key: 'max', kind: 'float', label: 'f_max' }],
  releaseType: [{ key: 'types', kind: 'types', label: 'f_types' }],
  compilation: VALUE, favourite: VALUE, lossless: VALUE,
  lastPlayed: DAYS, addedAt: DAYS,
  duration: [
    { key: 'minSeconds', kind: 'int', label: 'f_min_seconds' },
    { key: 'maxSeconds', kind: 'int', label: 'f_max_seconds' },
  ],
  codec: [{ key: 'codecs', kind: 'codecs', label: 'f_codecs' }],
  library: [{ key: 'ids', kind: 'libraries', label: 'f_libraries' }],
};

export function newCriterion(type: CriterionType): Criterion {
  const c: Record<string, unknown> = { type };
  for (const f of CRITERION_FIELDS[type]) {
    if (f.kind === 'text') c[f.key] = '';
    else if (f.kind === 'bool') c[f.key] = true;
    else if (f.kind === 'types' || f.kind === 'codecs' || f.kind === 'libraries') c[f.key] = [];
  }
  return c as Criterion;
}

export function defaultRules(): SmartRules {
  return { match: 'all', criteria: [newCriterion('artist')], sort: { by: 'title', descending: false }, limit: null };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function rangeValid(lo: unknown, hi: unknown, floor: number, ceil: number, int: boolean): boolean {
  const a = num(lo);
  const b = num(hi);
  if (a === undefined && b === undefined) return false;
  const ok = (v: number | undefined) => v === undefined || (v >= floor && v <= ceil && (!int || Number.isInteger(v)));
  return ok(a) && ok(b) && (a === undefined || b === undefined || a <= b);
}

const textValid = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 255;
const listValid = (v: unknown) => Array.isArray(v) && v.length > 0;

export function criterionValid(c: Criterion): boolean {
  switch (c.type) {
    case 'artist': case 'albumArtist': case 'composer': case 'genre': return textValid(c.name);
    case 'work': return textValid(c.title);
    case 'year': case 'originalYear': return rangeValid(c.min, c.max, 0, 9999, true);
    case 'rating': return rangeValid(c.min, c.max, 1, 5, true);
    case 'playCount': return rangeValid(c.min, c.max, 0, Number.MAX_SAFE_INTEGER, true);
    case 'popularity': return rangeValid(c.min, c.max, 0, Number.MAX_VALUE, false);
    case 'duration': return rangeValid(c.minSeconds, c.maxSeconds, 0, Number.MAX_SAFE_INTEGER, true);
    case 'lastPlayed': case 'addedAt': {
      const w = num(c.withinDays);
      const o = num(c.olderThanDays);
      return (w !== undefined || o !== undefined) && [w, o].every((v) => v === undefined || (Number.isInteger(v) && v >= 0));
    }
    case 'releaseType': return listValid(c.types);
    case 'codec': return listValid(c.codecs);
    case 'library': return listValid(c.ids);
    case 'compilation': case 'favourite': case 'lossless': return typeof c.value === 'boolean';
  }
}

export function rulesValid(r: SmartRules): boolean {
  const limitOk = r.limit === null || (Number.isInteger(r.limit) && r.limit >= 1 && r.limit <= 5000);
  return r.criteria.length >= 1 && r.criteria.length <= 50 && r.criteria.every(criterionValid) && limitOk;
}

/** The body to send: text trimmed, the editor's blank bounds dropped. */
export function cleanRules(r: SmartRules): SmartRules {
  const criteria = r.criteria.map((c) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined || v === null) continue;
      out[k] = typeof v === 'string' && k !== 'type' ? v.trim() : v;
    }
    return out as Criterion;
  });
  return { ...r, criteria };
}

export type PreviewState = { status: 'idle' | 'loading' | 'ready' | 'error'; count: number | null };

/** Debounced live count: only the latest request may report, an invalid rule set resets to idle. */
export function createPreviewer(fetchCount: (r: SmartRules) => Promise<number>, onState: (s: PreviewState) => void, delayMs = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  return {
    request(rules: SmartRules | null) {
      clearTimeout(timer);
      const id = ++seq;
      if (!rules || !rulesValid(rules)) return onState({ status: 'idle', count: null });
      onState({ status: 'loading', count: null });
      timer = setTimeout(() => {
        fetchCount(cleanRules(rules)).then(
          (count) => id === seq && onState({ status: 'ready', count }),
          () => id === seq && onState({ status: 'error', count: null }),
        );
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      seq++;
    },
  };
}
