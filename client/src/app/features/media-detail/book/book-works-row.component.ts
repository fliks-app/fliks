import { Component, input } from '@angular/core';
import { HorizontalScrollerComponent } from '../../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { mediaDetailLink } from '../../../core/media-kinds';

export interface WorkItem {
  id: number;
  title: string;
  posterUrl: string | null;
  /** Position in its series, shown as `#label`. */
  label: string | null;
  progressPercent: number;
}

@Component({
  selector: 'app-book-works-row',
  imports: [HorizontalScrollerComponent, MediaCardComponent],
  templateUrl: './book-works-row.component.html',
  host: { class: 'block' },
})
export class BookWorksRowComponent {
  readonly heading = input.required<string>();
  readonly items = input.required<WorkItem[]>();
  /** The work on screen, marked in its own series row. */
  readonly currentId = input<number | null>(null);

  protected readonly link = (id: number) => mediaDetailLink('book', id);
}
