import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
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
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-1">
        <h2 class="text-lg font-bold">{{ 'playback_settings.sub_appearance_title' | translate }}</h2>
        <p class="text-sm text-base-content/60">{{ 'playback_settings.sub_appearance_hint' | translate }}</p>
      </div>

      <label class="form-control w-full max-w-xs">
        <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_size' | translate }}</span></div>
        <select class="select select-bordered w-full" [ngModel]="size()" (ngModelChange)="sizeChange.emit($event)">
          @for (s of sizeOptions; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
        </select>
      </label>

      <label class="form-control w-full max-w-xs">
        <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_color' | translate }}</span></div>
        <select class="select select-bordered w-full" [ngModel]="color()" (ngModelChange)="colorChange.emit($event)">
          @for (c of colorOptions; track c.value) { <option [value]="c.value">{{ c.label }}</option> }
        </select>
      </label>

      <label class="form-control w-full max-w-xs">
        <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_shadow' | translate }}</span></div>
        <select class="select select-bordered w-full" [ngModel]="shadow()" (ngModelChange)="shadowChange.emit($event)">
          @for (s of shadowOptions; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
        </select>
      </label>

      <label class="form-control w-full max-w-xs">
        <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_bg' | translate }}</span></div>
        <select class="select select-bordered w-full" [ngModel]="background()" (ngModelChange)="backgroundChange.emit($event)">
          @for (b of bgOptions; track b.value) { <option [value]="b.value">{{ b.label }}</option> }
        </select>
      </label>
    </div>
  `,
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
