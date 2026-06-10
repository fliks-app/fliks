import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A daisyUI badge that doubles as a progress indicator: when `percent` is set
 *  the badge fills left-to-right and appends the value. Used by the request
 *  views to show a download advancing inside the status badge. */
@Component({
  selector: 'app-progress-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './progress-badge.component.html',
})
export class ProgressBadgeComponent {
  readonly label = input('');
  /** 0–100, or null for a plain badge with no progress fill. */
  readonly percent = input<number | null>(null);
  /** daisyUI colour class, e.g. `badge-info`. */
  readonly badgeClass = input('');
}
