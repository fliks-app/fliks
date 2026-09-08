import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslatePipe } from '@ngx-translate/core';
import { CastSettingsService } from '../../../core/services/cast-settings.service';
import { persistOnChange } from '../../../core/utils/persist-on-change';
import { SubtitleAppearanceComponent } from '../../../shared/components/subtitle-appearance/subtitle-appearance';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { QUALITY_OPTIONS, AUDIO_CHANNEL_OPTIONS } from '../playback-options';

@Component({
  selector: 'app-cast-settings',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, SubtitleAppearanceComponent, ToggleFieldComponent],
  templateUrl: './cast-settings.html',
})
export class CastSettingsPageComponent {
  private readonly castSettings = inject(CastSettingsService);
  readonly qualityOptions = QUALITY_OPTIONS;
  readonly audioOptions = AUDIO_CHANNEL_OPTIONS;

  private readonly initial = this.castSettings.get();
  readonly hdr = signal(this.initial.hdr);
  readonly maxQuality = signal(this.initial.maxQuality);
  readonly audioChannels = signal(this.initial.audioChannels);

  readonly subSize = signal(this.initial.subtitleStyle.size);
  readonly subColor = signal(this.initial.subtitleStyle.color);
  readonly subShadow = signal(this.initial.subtitleStyle.shadow);
  readonly subBackground = signal(this.initial.subtitleStyle.background);

  constructor() {
    persistOnChange(
      () => ({
        hdr: this.hdr(),
        maxQuality: this.maxQuality(),
        audioChannels: this.audioChannels(),
        subtitleStyle: {
          size: this.subSize(),
          color: this.subColor(),
          shadow: this.subShadow(),
          background: this.subBackground(),
        },
      }),
      // Spread first: another page owns fields of this store, and rebuilding
      // the object from this form's controls alone would silently reset them.
      (values) => this.castSettings.save({ ...this.castSettings.get(), ...values }),
    );
  }
}
