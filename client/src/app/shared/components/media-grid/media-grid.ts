import { ChangeDetectionStrategy, Component } from '@angular/core';

/** The card grid of a person's or an artist's works: the columns and gaps every title page shares, down to the TV layout. */
@Component({
  selector: 'app-media-grid',
  template: '<ng-content />',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 4xl:grid-cols-14 5xl:grid-cols-18 tv:grid-cols-6 gap-1.5 sm:gap-4 tv:gap-8',
  },
})
export class MediaGridComponent {}
