import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TmdbGenre } from '../../../core/services/api/metadata.service';
import { SearchParams } from '../../../core/services/api/media.service';
import { TvSelectDirective } from '../../directives/tv-select.directive';
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
export function libraryFilterParams(f: { type: SearchContentType; genreNames: string[]; sort: string; voteMin: number; yearMin: number | null; yearMax: number | null }): SearchParams {
  const p: SearchParams = {};
  if (f.sort === 'primary_release_date.desc') Object.assign(p, { sortBy: 'year', sortOrder: 'DESC' });
  if (f.sort === 'vote_average.desc') Object.assign(p, { sortBy: 'rating', sortOrder: 'DESC' });
  if (f.type !== 'all') p.type = f.type as SearchParams['type'];
  if (f.genreNames.length) p.genres = f.genreNames;
  if (f.yearMin != null) p.yearMin = f.yearMin;
  if (f.yearMax != null) p.yearMax = f.yearMax;
  if (f.voteMin) p.voteMin = f.voteMin;
  return p;
}

/** Sort, genre, rating and year filters of the search page, shared with the media picker. */
@Component({
  selector: 'app-search-filters',
  imports: [FormsModule, TranslatePipe, TvSelectDirective],
  templateUrl: './search-filters.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFiltersComponent {
  readonly genres = input<TmdbGenre[]>([]);
  readonly selectedGenres = model<ReadonlySet<number>>(new Set());
  readonly sort = model(DEFAULT_SORT);
  readonly voteMin = model(0);
  readonly yearMin = model<number | null>(null);
  readonly yearMax = model<number | null>(null);

  protected readonly sortOptions = SORT_OPTIONS;
  protected readonly engaged = computed(() => filtersEngaged(this.selectedGenres(), this.voteMin(), this.yearMin(), this.yearMax()));

  protected toggleGenre(id: number): void {
    const next = new Set(this.selectedGenres());
    if (!next.delete(id)) next.add(id);
    this.selectedGenres.set(next);
  }

  protected clear(): void {
    this.selectedGenres.set(new Set());
    this.sort.set(DEFAULT_SORT);
    this.voteMin.set(0);
    this.yearMin.set(null);
    this.yearMax.set(null);
  }
}
