import { Component, input, type Signal } from '@angular/core';
import { formatTime } from '../../../core/utils/player.utils';

/** The elapsed and remaining time of the seekbar row, read from a signal so a tick re-renders only these two labels. */
@Component({
  selector: 'app-time-label',
  templateUrl: './time-label.html',
  host: { class: 'contents' },
})
export class TimeLabelComponent {
  readonly time = input.required<Signal<number>>();
  readonly duration = input(0);

  protected readonly formatTime = formatTime;

  protected remaining(current: number, total: number): string {
    if (!total || !isFinite(total)) return '';
    return '-' + formatTime(Math.max(0, total - current));
  }
}
