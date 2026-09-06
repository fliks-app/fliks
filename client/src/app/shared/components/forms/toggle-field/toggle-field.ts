import {
  Component,
  input,
  model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * DaisyUI toggle (switch) with optional hint underneath. Two-way `[(value)]`.
 *
 * <app-toggle-field
 *   [(value)]="autoSkipIntro"
 *   [label]="'playback_settings.player_auto_skip_intro' | translate"
 *   [hint]="'playback_settings.player_auto_skip_intro_hint' | translate" />
 */
@Component({
  selector: 'app-toggle-field',
  imports: [FormsModule],
  templateUrl: './toggle-field.html',
})
export class ToggleFieldComponent {
  readonly value = model.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly disabled = input<boolean>(false);
  /** Override the toggle accent color (default: toggle-primary). */
  readonly toggleClass = input<string>('toggle-primary');
}
