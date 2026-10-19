import { Component, input } from '@angular/core';

/** Card-shaped placeholder sized by its container; put `animate-pulse` there, as it drives the shimmer and the TV WebView `aspect-ratio` fallback. */
@Component({
  selector: 'app-card-skeleton',
  templateUrl: './card-skeleton.html',
  host: { class: 'block' },
})
export class CardSkeletonComponent {
  /** Art ratio of the card being stood in for. */
  readonly aspect = input<'portrait' | 'landscape' | 'square'>('portrait');
}
