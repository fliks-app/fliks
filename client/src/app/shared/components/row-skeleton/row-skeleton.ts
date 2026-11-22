import { Component, input } from '@angular/core';

/** Row-shaped placeholders for a list or detail page whose layout is known before its data. */
@Component({
  selector: 'app-row-skeleton',
  template: `
    <div class="flex flex-col gap-2 sm:gap-3 animate-pulse" aria-hidden="true">
      @for (i of slots(); track i) {
        <div class="bg-base-300/40 rounded-lg" [class.h-16]="!tall()" [class.h-40]="tall()"></div>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class RowSkeletonComponent {
  readonly rows = input(6);
  readonly tall = input(false);
  protected slots() {
    return Array.from({ length: this.rows() }, (_, i) => i);
  }
}
