import {
  Component,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { TranslatePipe } from '@ngx-translate/core';
import {
  SIZE_OPTIONS,
  COLOR_OPTIONS,
  SHADOW_OPTIONS,
  BG_OPTIONS,
} from '../../../features/playback-settings/playback-options';

/**
 * Subtitle appearance preset selectors (size / colour / shadow /
 * background), shared between the local player settings and the Cast
 * settings page so users see one familiar form everywhere.
 *
 * The values stay raw preset strings (`small`, `white`, `drop`,
 * `transparent`, …); each consumer is free to interpret them — Shaka CSS
 * for local playback, Cast `TextTrackStyle` mapping for the receiver.
 */
@Component({
  selector: 'app-subtitle-appearance',
  standalone: true,
  imports: [TvSelectDirective, FormsModule, TranslatePipe],
  templateUrl: './subtitle-appearance.html',
})
export class SubtitleAppearanceComponent {
  readonly size = input.required<string>();
  readonly color = input.required<string>();
  readonly shadow = input.required<string>();
  readonly background = input.required<string>();

  readonly sizeChange = output<string>();
  readonly colorChange = output<string>();
  readonly shadowChange = output<string>();
  readonly backgroundChange = output<string>();

  protected readonly sizeOptions = SIZE_OPTIONS;
  protected readonly colorOptions = COLOR_OPTIONS;
  protected readonly shadowOptions = SHADOW_OPTIONS;
  protected readonly bgOptions = BG_OPTIONS;
}
