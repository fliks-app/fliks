import { Component, computed, input } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

/** One label and value of the grid; a fact with no value is not drawn. */
export interface Fact {
  /** Translation key of the label, or the label itself when it is a proper name (IMDB, TMDB). */
  label: string;
  translate?: boolean;
  value: string | number | null | undefined;
  format?: 'date' | 'currency';
}

/** The label and value pairs of a title, two to a row. */
@Component({
  selector: 'app-facts-grid',
  imports: [CurrencyPipe, LocaleDatePipe, TranslatePipe],
  templateUrl: './facts-grid.html',
  host: { class: 'block' },
})
export class FactsGridComponent {
  readonly facts = input.required<Fact[]>();
  protected readonly shown = computed(() => this.facts().filter((f) => f.value !== null && f.value !== undefined && f.value !== '' && f.value !== 0));
}
