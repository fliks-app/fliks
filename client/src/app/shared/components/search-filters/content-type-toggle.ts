import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SearchContentType } from './search-filters';

/** All / movies / series switch of the search page and the media picker. */
@Component({
  selector: 'app-content-type-toggle',
  imports: [TranslatePipe],
  templateUrl: './content-type-toggle.html',
  host: { class: 'join max-w-full overflow-x-auto scroll-ring-safe' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentTypeToggleComponent {
  readonly value = model<SearchContentType>('all');
  readonly withBooks = input(false);
  readonly withMusic = input(false);
  protected readonly types = computed<{ value: SearchContentType; labelKey: string }[]>(() => [
    { value: 'all', labelKey: 'search.filter_all' },
    { value: 'movie', labelKey: 'search.filter_movies' },
    { value: 'series', labelKey: 'search.filter_series' },
    ...(this.withBooks() ? [{ value: 'book' as const, labelKey: 'books_search.filter_books' }] : []),
    ...(this.withMusic() ? [{ value: 'album' as const, labelKey: 'search.filter_music' }] : []),
  ]);
}
