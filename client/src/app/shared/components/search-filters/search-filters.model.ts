import type { SearchParams } from '../../../core/services/api/media.service';
import type { MediaType } from '../../../core/enums/media-type.enum';

export type SearchContentType = 'all' | MediaType;

export const DEFAULT_SORT = 'popularity.desc';

/** TMDB /discover sort values; the library maps them in {@link libraryFilterParams}. */
export const SORT_OPTIONS = [
  { value: DEFAULT_SORT, labelKey: 'search.sort_popularity' },
  { value: 'vote_average.desc', labelKey: 'search.sort_rating' },
  { value: 'primary_release_date.desc', labelKey: 'search.sort_recent' },
];

/** Any narrowing filter; sort alone doesn't count. */
export function filtersEngaged(genres: ReadonlySet<number>, voteMin: number, yearMin: number | null, yearMax: number | null): boolean {
  return genres.size > 0 || voteMin > 0 || yearMin != null || yearMax != null;
}

/** Library query fields for the panel's values; genres go by name, the library stores no TMDB id. */
export function libraryFilterParams(f: { type: SearchContentType | MediaType[]; genreNames: string[]; sort: string; voteMin: number; yearMin: number | null; yearMax: number | null }): SearchParams {
  const p: SearchParams = {};
  if (f.sort === 'primary_release_date.desc') Object.assign(p, { sortBy: 'year', sortOrder: 'DESC' });
  if (f.sort === 'vote_average.desc') Object.assign(p, { sortBy: 'rating', sortOrder: 'DESC' });
  if (f.type !== 'all') p.type = f.type;
  if (f.genreNames.length) p.genres = f.genreNames;
  if (f.yearMin != null) p.yearMin = f.yearMin;
  if (f.yearMax != null) p.yearMax = f.yearMax;
  if (f.voteMin) p.voteMin = f.voteMin;
  return p;
}
