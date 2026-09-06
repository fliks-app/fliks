import { Component, computed, input } from '@angular/core';

/** A daisyUI badge that doubles as a progress indicator: when `percent` is set
 *  the badge fills left-to-right and appends the value. Used by the request
 *  views to show a download advancing inside the status badge. */
@Component({
  selector: 'app-progress-badge',
  templateUrl: './progress-badge.component.html',
})
export class ProgressBadgeComponent {
  readonly label = input('');
  /** 0–100, or null for a plain badge with no progress fill. */
  readonly percent = input<number | null>(null);
  /** Shows a spinner before the label, for a state with no percentage of its own to show. */
  readonly busy = input(false);
  /** daisyUI colour class, e.g. `badge-info`. */
  readonly badgeClass = input('');
  /** `xl` matches the play button — full width, same height and radius token —
   *  for the mobile header, where the download is the page's headline state. */
  readonly size = input<'sm' | 'xl'>('sm');

  protected readonly rootClass = computed(() =>
    this.size() === 'xl'
      ? `${this.badgeClass()} w-full h-10 px-4 text-base font-medium justify-center`
      : `${this.badgeClass()} badge-sm`,
  );
}
