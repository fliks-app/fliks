import { Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TmdbGenre } from '../../../core/services/api/metadata.service';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { DEFAULT_SORT, SORT_OPTIONS, filtersEngaged, type SearchContentType } from './search-filters.model';

/** Sort, genre, rating and year filters of the search page, shared with the media picker. */
@Component({
  selector: 'app-search-filters',
  imports: [FormsModule, TranslatePipe, TvSelectDirective],
  templateUrl: './search-filters.html',
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
