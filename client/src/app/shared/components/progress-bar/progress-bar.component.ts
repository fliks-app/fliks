import { Component, input } from '@angular/core';
import { ProgressVariant } from '../../utils/download-format';

/** Thin reusable progress bar. `percent` is 0–100; `variant` drives the colour.
 *  Shared by the Activity queue, request rows, and media-detail. */
@Component({
  selector: 'app-progress-bar',
  templateUrl: './progress-bar.component.html',
})
export class ProgressBarComponent {
  readonly percent = input(0);
  readonly variant = input<ProgressVariant>('primary');
}
