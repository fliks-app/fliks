import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CastSettingsService, CastSettings } from '../../../core/services/cast-settings.service';
import { ToastService } from '../../../core/services/toast.service';
import { QUALITY_OPTIONS, AUDIO_CHANNEL_OPTIONS } from '../playback-options';

@Component({
  selector: 'app-cast-settings',
  imports: [FormsModule, TranslateModule],
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

  ngOnInit() {
    const c = this.castSettings.get();
    this.hdr.set(c.hdr);
    this.maxQuality.set(c.maxQuality);
    this.audioChannels.set(c.audioChannels);
  }

  save() {
    const settings: CastSettings = {
      hdr: this.hdr(),
      maxQuality: this.maxQuality(),
      audioChannels: this.audioChannels(),
    };
    this.castSettings.save(settings);
    this.toast.success(this.translate.instant('common.settings_saved'));
  }
}
