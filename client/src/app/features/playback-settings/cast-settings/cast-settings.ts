import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CastSettingsService, CastSettings, DEFAULT_CAST_SUBTITLE_STYLE } from '../../../core/services/cast-settings.service';
import { ToastService } from '../../../core/services/toast.service';
import { SubtitleAppearanceComponent } from '../../../shared/components/subtitle-appearance/subtitle-appearance';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { QUALITY_OPTIONS, AUDIO_CHANNEL_OPTIONS } from '../playback-options';

@Component({
  selector: 'app-cast-settings',
  imports: [TvSelectDirective, FormsModule, TranslateModule, SubtitleAppearanceComponent, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cast-settings.html',
})
export class CastSettingsPageComponent implements OnInit {
  private readonly castSettings = inject(CastSettingsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly qualityOptions = QUALITY_OPTIONS;
  readonly audioOptions = AUDIO_CHANNEL_OPTIONS;

  readonly hdr = signal(false);
  readonly maxQuality = signal('1080p');
  readonly audioChannels = signal(2);

  readonly subSize = signal(DEFAULT_CAST_SUBTITLE_STYLE.size);
  readonly subColor = signal(DEFAULT_CAST_SUBTITLE_STYLE.color);
  readonly subShadow = signal(DEFAULT_CAST_SUBTITLE_STYLE.shadow);
  readonly subBackground = signal(DEFAULT_CAST_SUBTITLE_STYLE.background);

  ngOnInit() {
    const c = this.castSettings.get();
    this.hdr.set(c.hdr);
    this.maxQuality.set(c.maxQuality);
    this.audioChannels.set(c.audioChannels);
    this.subSize.set(c.subtitleStyle.size);
    this.subColor.set(c.subtitleStyle.color);
    this.subShadow.set(c.subtitleStyle.shadow);
    this.subBackground.set(c.subtitleStyle.background);
  }

  save() {
    const settings: CastSettings = {
      // Spread first: another page owns fields of this store, and rebuilding the
      // object from this form's controls alone would silently reset them.
      ...this.castSettings.get(),
      hdr: this.hdr(),
      maxQuality: this.maxQuality(),
      audioChannels: this.audioChannels(),
      subtitleStyle: {
        size: this.subSize(),
        color: this.subColor(),
        shadow: this.subShadow(),
        background: this.subBackground(),
      },
    };
    this.castSettings.save(settings);
    this.toast.success(this.translate.instant('common.settings_saved'));
  }
}
