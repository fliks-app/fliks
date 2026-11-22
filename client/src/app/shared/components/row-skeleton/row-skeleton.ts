import { Component, input } from '@angular/core';

/** Row-shaped placeholders for a list or detail page whose layout is known before its data. */
@Component({
  selector: 'app-row-skeleton',
  templateUrl: './row-skeleton.html',
  host: { class: 'block' },
})
export class RowSkeletonComponent {
  readonly rows = input(6);
  readonly tall = input(false);
  protected slots() {
    return Array.from({ length: this.rows() }, (_, i) => i);
  }
}
