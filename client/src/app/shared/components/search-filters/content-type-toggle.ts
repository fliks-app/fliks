import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SearchContentType } from './search-filters';

/** All / movies / series switch of the media picker. */
@Component({
  selector: 'app-content-type-toggle',
  imports: [TranslatePipe],
  templateUrl: './content-type-toggle.html',
  host: { class: 'join max-w-full overflow-x-auto scroll-ring-safe' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentTypeToggleComponent {
  readonly value = model<SearchContentType>('all');
  protected readonly types: { value: SearchContentType; labelKey: string }[] = [
    { value: 'all', labelKey: 'search.filter_all' },
    { value: 'movie', labelKey: 'search.filter_movies' },
    { value: 'series', labelKey: 'search.filter_series' },
  ];
}
