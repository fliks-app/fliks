import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * One card-shaped placeholder: art box plus a title and subtitle bar. Sized by
 * its container, so the caller keeps its own grid or scroller classes and the
 * placeholders land where the real cards will. Put `animate-pulse` on that
 * container — it drives the shimmer and is what the TV WebView's
 * `aspect-ratio` fallback keys off.
 */
@Component({
  selector: 'app-card-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './card-skeleton.html',
  host: { class: 'block' },
})
export class CardSkeletonComponent {
  /** Art ratio of the card being stood in for. */
  readonly aspect = input<'portrait' | 'landscape' | 'square'>('portrait');
}
