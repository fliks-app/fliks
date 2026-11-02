import { Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { BookEdition } from '../../../core/services/api/books.models';
import { formatClock } from './book-media';

@Component({
  selector: 'app-book-editions',
  imports: [TranslatePipe],
  templateUrl: './book-editions.component.html',
  host: { class: 'block' },
})
export class BookEditionsComponent {
  readonly editions = input.required<BookEdition[]>();

  protected readonly clock = formatClock;
}
